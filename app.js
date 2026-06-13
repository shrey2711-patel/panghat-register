// =================================================================
// GOOGLE FIREBASE CONFIGURATION (Edit this section to change sync keys)
// =================================================================
const FIREBASE_CONFIG = {
  enabled: true, // Set to true to enable real-time cloud sync, false for offline local mode
  apiKey: "AIzaSyCP0aG1KnrQEvSHY4Os1o0secaKIe4T4zo",
  authDomain: "panghat-register.firebaseapp.com",
  projectId: "panghat-register",
  storageBucket: "panghat-register.firebasestorage.app",
  messagingSenderId: "737134243462",
  appId: "1:737134243462:web:b0e671e410d4f6f0c2eb07",
  measurementId: "G-55Y15XYWGP"
};
// =================================================================

// INITIAL DATA MERGE (Base template provided + pre-prepared fields)
const DEFAULT_RAW_DATA = [];

// App State Management
let DATA = [];
let filteredData = [];
let SIMULATED_TODAY = new Date(); // Holds current simulated calendar date
let activeStatusFilter = 'all';
const MASTER_PASSWORD = 'shrey@2711';
const uploadingDocIds = new Set();

// Setup LocalStorage or load defaults
// Setup IndexedDB Permanent Database
const DB_NAME = 'PanghatRegisterDB';
const DB_VERSION = 1;
const STORE_NAME = 'panghat_policies';
const FIREBASE_COLLECTION = 'panghat_policies';
const FIREBASE_STORAGE_ROOT = 'panghat_policies';
let dbInstance;

function generateUniqueId() {
  return 'MMC_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

function initDatabase() {
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = function(e) {
    const db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    }
  };

  request.onsuccess = function(e) {
    dbInstance = e.target.result;
    logActivity("🗄️ Permanent database (IndexedDB) connected successfully.", "info");

    // Load records and run migrations
    loadAllRecordsFromDB();

    // Connect to Firebase Cloud Sync if active
    initFirebaseConnection();
  };

  request.onerror = function() {
    logActivity("❌ Permanent database connection failed! Standard Storage fallback active.", "err");
    // Fallback to localStorage if blocked
    const fallbackData = localStorage.getItem('panghat_insurance_ledger');
    if (fallbackData) {
      try { DATA = JSON.parse(fallbackData); } catch(ex) { DATA = []; }
    } else {
      DATA = [];
    }
    applyFiltersAndStats();
  };

  // Pre-fill simulator to actual local date or preserved simulated date
  const preservedSimDate = localStorage.getItem('panghat_simulated_date');
  if (preservedSimDate) {
    SIMULATED_TODAY = new Date(preservedSimDate);
    document.getElementById('dateSimulator').value = preservedSimDate;
  } else {
    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('dateSimulator').value = todayStr;
    SIMULATED_TODAY = new Date(todayStr);
  }
  SIMULATED_TODAY.setHours(0,0,0,0);

  // Set default message template if not set
  if (!localStorage.getItem('panghat_whatsapp_template')) {
    const defaultTemplate = `Dear {name},\n\nThis is a friendly reminder that the insurance for your vehicle {vehicle} ({plate}) {expiry_status}.\n\n🚗 Vehicle: {vehicle}\n🔖 Plate Number: {plate}\n🏢 Provider: {insurance}\n📅 Expiry Date: {expiry}\n\nRemarks/Notes: {remarks}\n\nPlease renew at your earliest convenience to avoid penalties.\n\nThank you for choosing us!`;
    localStorage.setItem('panghat_whatsapp_template', defaultTemplate);
  }
}

function loadAllRecordsFromDB() {
  const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);

  // Migration check: check if localStorage has data to migrate
  const localData = localStorage.getItem('panghat_insurance_ledger');
  if (localData) {
    try {
      const parsed = JSON.parse(localData);
      if (parsed && parsed.length > 0) {
        logActivity(`🗄️ One-time Migration: Transferring ${parsed.length} records to permanent database...`, "info");
        let migratedCount = 0;
        parsed.forEach(item => {
          item.id = generateUniqueId();
          const req = store.add(item);
          req.onsuccess = function() {
            migratedCount++;
            if (migratedCount === parsed.length) {
              logActivity(`✅ Migration Complete: safely stored ${parsed.length} client files permanently!`, "info");
              localStorage.removeItem('panghat_insurance_ledger');
              fetchRecords(store);
            }
          };
        });
        return; // wait for migration callback
      }
    } catch(e) {
      console.error("Migration failed: ", e);
    }
  }

  fetchRecords(store);
}

function fetchRecords(store) {
  const req = store.getAll();
  req.onsuccess = function(e) {
    const rawData = e.target.result || [];
    let hasMigration = false;

    // Migrate any legacy numeric IDs to string IDs
    rawData.forEach(item => {
      if (typeof item.id === 'number') {
        const oldId = item.id;
        item.id = String(oldId);
        store.put(item);
        store.delete(oldId);
        hasMigration = true;
      }
    });

    if (hasMigration) {
      logActivity("🗄️ Database migration: converted legacy record numeric IDs to string IDs", "info");
      loadAllRecordsFromDB(); // Reload updated records
      return;
    }

    DATA = rawData;

    // Dynamic cleanup: clear any 2025 records
    const originalLength = DATA.length;
    DATA = DATA.filter(item => {
      const expYear = new Date(item.end_date).getFullYear();
      return expYear !== 2025;
    });
    if (DATA.length !== originalLength) {
      saveAllToIndexedDB();
      setTimeout(() => logActivity(`🗑️ dynamic cleanup: Cleared ${originalLength - DATA.length} old 2025 records.`, "err"), 100);
    }

    applyFiltersAndStats();
  };
}

function saveDatabase() {
  // Redundant lightweight backup of text fields to local storage
  try {
    const backupTextOnly = DATA.map(item => {
      const copy = { ...item };
      delete copy.policy_doc;
      delete copy.kyc_doc;
      delete copy.kyc_docs;
      return copy;
    });
    localStorage.setItem('panghat_insurance_ledger_backup', JSON.stringify(backupTextOnly));
  } catch(e) {
    // silently fail
  }
}

// Utility to completely rewrite IndexedDB (used for batch updates / cleanup)
function saveAllToIndexedDB() {
  const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.clear().onsuccess = function() {
    DATA.forEach(item => {
      if (!item.hasOwnProperty('id') || item.id === undefined || item.id === null || item.id === '') {
        item.id = generateUniqueId();
      }
      store.add(item);
    });
  };
}

// File helper: Convert file inputs to Base64 objects
function getFileData(fileInput) {
  return new Promise((resolve) => {
    const file = fileInput.files[0];
    if (!file) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
      resolve({
        name: file.name,
        type: file.type,
        data: e.target.result // Base64 data URL
      });
    };
    reader.onerror = function() {
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

// File helper: Convert file inputs to multiple Base64 objects
function getMultipleFilesData(fileInput) {
  return new Promise(async (resolve) => {
    const files = fileInput.files;
    if (!files || files.length === 0) {
      resolve([]);
      return;
    }

    const results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const data = await new Promise((resolveFile) => {
        const reader = new FileReader();
        reader.onload = function(e) {
          resolveFile({
            name: file.name,
            type: file.type,
            data: e.target.result // Base64 data URL
          });
        };
        reader.onerror = function() {
          resolveFile(null);
        };
        reader.readAsDataURL(file);
      });
      if (data) results.push(data);
    }
    resolve(results);
  });
}

// File helper: show single file preview in forms
function previewUploadFile(input, previewId) {
  const file = input.files[0];
  const label = document.getElementById(previewId);
  if (file) {
    let sizeStr = '';
    if (file.size > 1024 * 1024) sizeStr = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
    else sizeStr = (file.size / 1024).toFixed(1) + ' KB';

    label.innerHTML = `<i class="fa-solid fa-file-circle-check" style="color:var(--accent);"></i> ${file.name} (${sizeStr})`;
  } else {
    label.textContent = "No file attached";
  }
}

// File helper: show multiple file previews in forms
function previewUploadFilesMultiple(input, previewId) {
  const files = input.files;
  const label = document.getElementById(previewId);
  if (files && files.length > 0) {
    let text = `<i class="fa-solid fa-file-circle-check" style="color:var(--purple);"></i> Selected ${files.length} file(s):<br/>`;
    let fileList = [];
    for(let i=0; i<files.length; i++) {
      let file = files[i];
      let sizeStr = '';
      if (file.size > 1024 * 1024) sizeStr = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
      else sizeStr = (file.size / 1024).toFixed(1) + ' KB';
      fileList.push(`<span style="display:inline-block; margin-top:4px; margin-right:4px; font-size:11px; background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px; border:1px solid var(--border); color:var(--text-muted);"><i class="fa-solid fa-paperclip" style="color:var(--purple);font-size:10px;"></i> ${file.name} (${sizeStr})</span>`);
    }
    label.innerHTML = text + fileList.join(' ');
  } else {
    label.textContent = "No files attached";
  }
}

// File helper: download base64 documents safely in client-side
function downloadDoc(idx, type) {
  const item = DATA[idx];
  if (type === 'policy') {
    const doc = item.policy_doc;
    if (!doc) return;
    triggerFileDownload(doc, item.name);
  } else {
    const docs = Array.isArray(item.kyc_docs) ? item.kyc_docs : (item.kyc_doc ? [item.kyc_doc] : []);
    if (docs.length === 0) return;

    // Download each file sequentially with a 350ms delay to prevent browser blockages
    docs.forEach((doc, dIdx) => {
      setTimeout(() => {
        triggerFileDownload(doc, item.name);
      }, dIdx * 350);
    });
  }
}

function triggerFileDownload(doc, clientName) {
  try {
    if (doc.url) {
      // Open cloud storage URL in a new tab or trigger direct download
      const a = document.createElement('a');
      a.href = doc.url;
      a.target = '_blank';
      a.download = doc.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      logActivity(`📥 Opened cloud document: ${doc.name} for client ${clientName}`, "info");
      showToast(`Opening: ${doc.name}`);
      return;
    }

    const parts = doc.data.split(';base64,');
    const contentType = parts[0].split(':')[1];
    const raw = window.atob(parts[1]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);

    for (let i = 0; i < rawLength; ++i) {
      uInt8Array[i] = raw.charCodeAt(i);
    }

    const blob = new Blob([uInt8Array], { type: contentType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = doc.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    logActivity(`📥 Downloaded document: ${doc.name} for client ${clientName}`, "info");
    showToast(`Downloading: ${doc.name}`);
  } catch(e) {
    window.open(doc.data, '_blank');
    logActivity(`📥 Opened document in new window for client ${clientName}`, "info");
  }
}

// Session Audit Logging
function logActivity(text, type = "default") {
  const ledger = document.getElementById('activityLedger');
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const row = document.createElement('div');
  row.className = `ledger-row ${type}`;
  row.innerHTML = `<span class="time">[${timeStr}]</span> <span>${text}</span>`;

  ledger.insertBefore(row, ledger.firstChild);

  // Cap ledger items to 50
  if (ledger.childNodes.length > 50) {
    ledger.removeChild(ledger.lastChild);
  }
}

// Expiry Indicator Helper
function getDaysBucket(daysLeft) {
  if (daysLeft < 0) return 'expired';
  if (daysLeft === 0) return 'today';
  if (daysLeft <= 1) return 'days1';
  if (daysLeft <= 3) return 'days3';
  if (daysLeft <= 7) return 'days7';
  return 'future';
}

function formatDaysLabel(daysLeft) {
  if (daysLeft < 0) return `${Math.abs(daysLeft)}d Expired`;
  if (daysLeft === 0) return 'TODAY';
  if (daysLeft === 1) return 'TOMORROW';
  return `${daysLeft} Days`;
}

function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatCurrency(val) {
  if (!val || isNaN(val)) return '₹0';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(val);
}

// Indian mobile cleanup
function cleanAndFormatPhone(val) {
  if (!val) return '';
  let clean = String(val).replace(/[^0-9]/g, '');
  if (clean.length === 10) return '+91' + clean;
  if (clean.length === 12 && clean.startsWith('91')) return '+' + clean;
  return val;
}

// Format plate layout
function formatPlateNumber(val) {
  return String(val).toUpperCase().trim().replace(/\s+/g, '');
}

// TOAST NOTIFICATIONS
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  document.getElementById('toastMsg').textContent = msg;

  if (isError) {
    t.classList.add('err');
    icon.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
  } else {
    t.classList.remove('err');
    icon.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
  }

  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ==============================================
// CRUD CONTROLLERS
// ==============================================
function openAddModal() {
  // Clear inputs
  document.getElementById('addName').value = '';
  document.getElementById('addVehicle').value = '';
  document.getElementById('addPlate').value = '';
  document.getElementById('addInsurance').value = '';
  document.getElementById('addPolicyNo').value = '';
  document.getElementById('addStartDate').value = '';
  document.getElementById('addEndDate').value = '';
  document.getElementById('addAmount').value = '';
  document.getElementById('addPhone').value = '';
  document.getElementById('addNotes').value = '';

  // Clear document files inputs and previews
  document.getElementById('addPolicyDoc').value = '';
  document.getElementById('addKycDoc').value = '';
  document.getElementById('addPolicyPreview').textContent = 'No file attached';
  document.getElementById('addKycPreview').textContent = 'No files attached';

  openModal('addModal');
}

async function submitAddEntry() {
  const name = document.getElementById('addName').value.trim();
  const vehicle = document.getElementById('addVehicle').value.trim();
  const plate = document.getElementById('addPlate').value.trim();
  const insurance = document.getElementById('addInsurance').value.trim();
  const policyNo = document.getElementById('addPolicyNo').value.trim();
  const startDate = document.getElementById('addStartDate').value;
  const endDate = document.getElementById('addEndDate').value;
  const amount = document.getElementById('addAmount').value;
  const phone = document.getElementById('addPhone').value.trim();
  const notes = document.getElementById('addNotes').value.trim();

  if (!name || !vehicle || !plate || !insurance || !endDate || !phone) {
    showToast("Please fill in all mandatory (*) fields!", true);
    return;
  }

  // Read document files
  const policyDoc = await getFileData(document.getElementById('addPolicyDoc'));
  const kycDocs = await getMultipleFilesData(document.getElementById('addKycDoc'));

  const newEntry = {
    id: generateUniqueId(),
    name: name,
    vehicle: vehicle,
    plate: formatPlateNumber(plate),
    insurance: insurance,
    policy_no: policyNo,
    start_date: startDate,
    end_date: endDate,
    amount: amount ? Number(amount) : '',
    phone: cleanAndFormatPhone(phone),
    notes: notes,
    policy_doc: policyDoc,
    kyc_docs: kycDocs,
    kyc_doc: kycDocs.length > 0 ? kycDocs[0] : null // compatibility
  };

  // Save to Database (Cloud Sync or IndexedDB Fallback)
  if (cloudSyncActive) {
    showToast("Uploading attachments to cloud...", false);
    (async () => {
      let docId;
      try {
        const newDocRef = firestoreInstance.collection(FIREBASE_COLLECTION).doc();
        docId = newDocRef.id;
        uploadingDocIds.add(docId);
        const cloudEntry = { ...newEntry };
        delete cloudEntry.id;

        if (newEntry.policy_doc) {
          const url = await uploadFileToFirebaseStorage(newDocRef.id, newEntry.policy_doc, 'policy_doc');
          cloudEntry.policy_doc = { name: newEntry.policy_doc.name, type: newEntry.policy_doc.type, url };
        }

        if (newEntry.kyc_docs && newEntry.kyc_docs.length > 0) {
          const cloudKycDocs = [];
          for (let i = 0; i < newEntry.kyc_docs.length; i++) {
            const kyc = newEntry.kyc_docs[i];
            const url = await uploadFileToFirebaseStorage(newDocRef.id, kyc, `kyc_doc_${i}`);
            cloudKycDocs.push({ name: kyc.name, type: kyc.type, url });
          }
          cloudEntry.kyc_docs = cloudKycDocs;
          cloudEntry.kyc_doc = cloudKycDocs.length > 0 ? cloudKycDocs[0] : null;
        }

        await newDocRef.set(cloudEntry);
        closeModal('addModal');
        showToast(`Successfully saved ${name} to cloud!`);
        logActivity(`➕ Added cloud register: ${name} (${formatPlateNumber(plate)})`, "info");
      } catch (ex) {
        console.error("Cloud save failed:", ex);
        showToast("Cloud write failed! Saved locally instead.", true);
        saveToLocalIndexedDBOnly(newEntry, name, plate);
      } finally {
        if (docId) {
          setTimeout(() => {
            uploadingDocIds.delete(docId);
          }, 1000);
        }
      }
    })();
    return;
  }

  saveToLocalIndexedDBOnly(newEntry, name, plate);
}

function saveToLocalIndexedDBOnly(entry, name, plate) {
  const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const req = store.add(entry);

  req.onsuccess = function(e) {
    entry.id = e.target.result; // Set autoincrement primary key
    DATA.push(entry);
    saveDatabase(); // redundant fallback
    closeModal('addModal');
    applyFiltersAndStats();
    showToast(`Successfully added record for ${name}!`);
    logActivity(`➕ Added daily policy register: ${name} (${formatPlateNumber(plate)})`, "info");
  };

  req.onerror = function() {
    showToast("Failed to save to local database!", true);
  };
}

function openEditModal(idx) {
  const item = DATA[idx];
  document.getElementById('editIndex').value = idx;
  document.getElementById('editName').value = item.name;
  document.getElementById('editVehicle').value = item.vehicle;
  document.getElementById('editPlate').value = item.plate;
  document.getElementById('editInsurance').value = item.insurance;
  document.getElementById('editPolicyNo').value = item.policy_no || '';
  document.getElementById('editStartDate').value = item.start_date || '';
  document.getElementById('editEndDate').value = item.end_date || '';
  document.getElementById('editAmount').value = item.amount || '';
  document.getElementById('editPhone').value = item.phone;
  document.getElementById('editNotes').value = item.notes || '';

  // Reset file selectors
  document.getElementById('editPolicyDoc').value = '';
  document.getElementById('editKycDoc').value = '';

  // Load existing files previews
  const policyPrev = document.getElementById('editPolicyPreview');
  if (item.policy_doc) {
    policyPrev.innerHTML = `<i class="fa-solid fa-file-pdf" style="color:var(--accent);"></i> Already Attached: <strong>${item.policy_doc.name}</strong>`;
  } else {
    policyPrev.textContent = "No file attached";
  }

  const kycPrev = document.getElementById('editKycPreview');
  const kycDocs = Array.isArray(item.kyc_docs) ? item.kyc_docs : (item.kyc_doc ? [item.kyc_doc] : []);
  if (kycDocs.length > 0) {
    let pills = kycDocs.map(doc => `<span style="display:inline-block; margin-top:4px; margin-right:4px; font-size:11px; background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px; border:1px solid var(--border); color:var(--text-muted);"><i class="fa-solid fa-paperclip" style="color:var(--purple);font-size:10px;"></i> ${doc.name}</span>`).join(' ');
    kycPrev.innerHTML = `<i class="fa-solid fa-id-card" style="color:var(--purple);"></i> Already Attached (${kycDocs.length} file(s)):<br/>${pills}<br/><span style="font-size:10.5px;color:var(--amber);margin-top:4px;display:inline-block;"><i class="fa-solid fa-triangle-exclamation"></i> Selecting new files will replace all existing KYC attachments!</span>`;
  } else {
    kycPrev.textContent = "No files attached";
  }

  openModal('editModal');
}

async function submitEditEntry() {
  const idx = Number(document.getElementById('editIndex').value);
  const name = document.getElementById('editName').value.trim();
  const vehicle = document.getElementById('editVehicle').value.trim();
  const plate = document.getElementById('editPlate').value.trim();
  const insurance = document.getElementById('editInsurance').value.trim();
  const policyNo = document.getElementById('editPolicyNo').value.trim();
  const startDate = document.getElementById('editStartDate').value;
  const endDate = document.getElementById('editEndDate').value;
  const amount = document.getElementById('editAmount').value;
  const phone = document.getElementById('editPhone').value.trim();
  const notes = document.getElementById('editNotes').value.trim();

  if (!name || !vehicle || !plate || !insurance || !endDate || !phone) {
    showToast("Please fill in all mandatory fields!", true);
    return;
  }

  // Process attachments (preserve existing if no new ones are uploaded)
  let policyDoc = await getFileData(document.getElementById('editPolicyDoc'));
  if (!policyDoc && DATA[idx].policy_doc) {
    policyDoc = DATA[idx].policy_doc;
  }

  let kycDocs = await getMultipleFilesData(document.getElementById('editKycDoc'));
  if (kycDocs.length === 0) {
    // Preserve existing kyc_docs if no new files selected
    kycDocs = Array.isArray(DATA[idx].kyc_docs) ? DATA[idx].kyc_docs : (DATA[idx].kyc_doc ? [DATA[idx].kyc_doc] : []);
  }

  const updatedEntry = {
    ...DATA[idx],
    name: name,
    vehicle: vehicle,
    plate: formatPlateNumber(plate),
    insurance: insurance,
    policy_no: policyNo,
    start_date: startDate,
    end_date: endDate,
    amount: amount ? Number(amount) : '',
    phone: cleanAndFormatPhone(phone),
    notes: notes,
    policy_doc: policyDoc,
    kyc_docs: kycDocs,
    kyc_doc: kycDocs.length > 0 ? kycDocs[0] : null // compatibility
  };

  // Write to Database (Cloud Sync or IndexedDB Fallback)
  if (cloudSyncActive) {
    showToast("Updating cloud files...", false);
    (async () => {
      const docId = String(DATA[idx].id);
      uploadingDocIds.add(docId);
      try {
        const cloudEntry = { ...updatedEntry };
        delete cloudEntry.id;

        // Upload new files if uploaded
        if (updatedEntry.policy_doc && updatedEntry.policy_doc.data && !updatedEntry.policy_doc.url) {
          const url = await uploadFileToFirebaseStorage(docId, updatedEntry.policy_doc, 'policy_doc');
          cloudEntry.policy_doc = { name: updatedEntry.policy_doc.name, type: updatedEntry.policy_doc.type, url };
        }

        if (updatedEntry.kyc_docs && updatedEntry.kyc_docs.length > 0) {
          const cloudKycDocs = [];
          for (let i = 0; i < updatedEntry.kyc_docs.length; i++) {
            const kyc = updatedEntry.kyc_docs[i];
            if (kyc.data && !kyc.url) {
              const url = await uploadFileToFirebaseStorage(docId, kyc, `kyc_doc_${i}`);
              cloudKycDocs.push({ name: kyc.name, type: kyc.type, url });
            } else {
              cloudKycDocs.push(kyc);
            }
          }
          cloudEntry.kyc_docs = cloudKycDocs;
          cloudEntry.kyc_doc = cloudKycDocs.length > 0 ? cloudKycDocs[0] : null;
        }

        await firestoreInstance.collection(FIREBASE_COLLECTION).doc(docId).set(cloudEntry);

        closeModal('editModal');
        showToast(`Successfully updated ${name} in cloud!`);
        logActivity("📝 Updated cloud entry: " + name + " (" + formatPlateNumber(plate) + ")", "info");
      } catch (ex) {
        console.error("Cloud update failed:", ex);
        showToast("Cloud update failed! Updated locally instead.", true);
        saveEditToLocalIndexedDBOnly(idx, updatedEntry, name, plate);
      } finally {
        setTimeout(() => {
          uploadingDocIds.delete(docId);
        }, 1000);
      }
    })();
    return;
  }

  saveEditToLocalIndexedDBOnly(idx, updatedEntry, name, plate);
}

function saveEditToLocalIndexedDBOnly(idx, updatedEntry, name, plate) {
  const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const req = store.put(updatedEntry);

  req.onsuccess = function() {
    DATA[idx] = updatedEntry;
    saveDatabase(); // redundant fallback
    closeModal('editModal');
    applyFiltersAndStats();
    showToast(`Successfully updated register for ${name}`);
    logActivity("📝 Updated ledger entry: " + name + " (" + formatPlateNumber(plate) + ")", "info");
  };

  req.onerror = function() {
    showToast("Failed to update local database!", true);
  };
}

function deleteEntry(idx) {
  if (confirm(`Are you absolutely sure you want to delete the record for ${DATA[idx].name}?`)) {
    const name = DATA[idx].name;
    const plate = DATA[idx].plate;
    const dbId = String(DATA[idx].id);

    if (cloudSyncActive) {
      showToast("Deleting from cloud...", false);
      (async () => {
        try {
          const docRef = firestoreInstance.collection(FIREBASE_COLLECTION).doc(dbId);
          const docSnap = await docRef.get();
          if (docSnap.exists) {
            const data = docSnap.data();
            if (data.policy_doc && data.policy_doc.url) {
              await deleteFileFromFirebaseStorage(data.policy_doc.url);
            }
            if (data.kyc_docs && Array.isArray(data.kyc_docs)) {
              for (const kyc of data.kyc_docs) {
                if (kyc.url) await deleteFileFromFirebaseStorage(kyc.url);
              }
            }
          }
          await docRef.delete();
          showToast(`Removed policy for ${name} from cloud.`);
          logActivity(`❌ Deleted cloud policy: ${name} (${plate})`, "err");
        } catch (ex) {
          console.error("Cloud delete failed:", ex);
          showToast("Failed to delete from cloud!", true);
        }
      })();
      return;
    }

    const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const req = store.delete(dbId);

    req.onsuccess = function() {
      DATA.splice(idx, 1);
      saveDatabase(); // redundant fallback
      applyFiltersAndStats();
      showToast(`Removed policy register for ${name}`);
      logActivity(`❌ Deleted policy register: ${name} (${plate})`, "err");
    };

    req.onerror = function() {
      showToast("Failed to delete from database!", true);
    };
  }
}

// Bulk delete controller
function deleteSelected() {
  const checkboxes = document.querySelectorAll('.row-cb:checked');
  if (checkboxes.length === 0) return;

  if (confirm(`Are you absolutely sure you want to delete ${checkboxes.length} selected policy records? This action is permanent!`)) {
    const indicesToDelete = Array.from(checkboxes).map(cb => Number(cb.dataset.index)).sort((a,b) => b - a);

    if (cloudSyncActive) {
      showToast("Deleting bulk records from cloud...", false);
      (async () => {
        try {
          for (const idx of indicesToDelete) {
            const dbId = DATA[idx].id;
            const docRef = firestoreInstance.collection(FIREBASE_COLLECTION).doc(dbId);
            const docSnap = await docRef.get();
            if (docSnap.exists) {
              const data = docSnap.data();
              if (data.policy_doc && data.policy_doc.url) {
                await deleteFileFromFirebaseStorage(data.policy_doc.url);
              }
              if (data.kyc_docs && Array.isArray(data.kyc_docs)) {
                for (const kyc of data.kyc_docs) {
                  if (kyc.url) await deleteFileFromFirebaseStorage(kyc.url);
                }
              }
            }
            await docRef.delete();
          }
          document.getElementById('selectAllCheckbox').checked = false;
          showToast(`Wiped ${checkboxes.length} records successfully.`);
          logActivity(`🗑️ Bulk Deleted: ${checkboxes.length} cloud records wiped.`, "err");
        } catch (ex) {
          console.error("Cloud bulk delete failed:", ex);
          showToast("Failed to delete all records from cloud!", true);
        }
      })();
      return;
    }

    const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    let deletedCount = 0;

    indicesToDelete.forEach(idx => {
      const dbId = DATA[idx].id;
      const req = store.delete(dbId);
      req.onsuccess = function() {
        DATA.splice(idx, 1);
        deletedCount++;
        if (deletedCount === indicesToDelete.length) {
          saveDatabase(); // redundant fallback
          document.getElementById('selectAllCheckbox').checked = false;
          applyFiltersAndStats();
          showToast(`Wiped ${indicesToDelete.length} records successfully.`);
          logActivity(`🗑️ Bulk Deleted: ${indicesToDelete.length} records wiped from register ledger`, "err");
        }
      };
    });
  }
}

// ==============================================
// VIEW RENDERING ENGINE & STATISTICS
// ==============================================
function updateLiveDateTime() {
  const dateLabel = document.getElementById('todayDateLabel');
  if (!dateLabel) return;

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  dateLabel.textContent = `${dateStr} • ${timeStr}`;
}

function updateSimulatedDate() {
  const selectedDate = document.getElementById('dateSimulator').value;
  if (!selectedDate) return;
  SIMULATED_TODAY = new Date(selectedDate);
  SIMULATED_TODAY.setHours(0,0,0,0);
  localStorage.setItem('panghat_simulated_date', selectedDate);

  // Update Header Date label with live time
  updateLiveDateTime();

  applyFiltersAndStats();
  logActivity(`⏰ Register calendar simulated to: ${formatDate(selectedDate)}`, "info");
}

function resetSimulatedDate() {
  const todayStr = new Date().toISOString().split('T')[0];
  document.getElementById('dateSimulator').value = todayStr;
  localStorage.removeItem('panghat_simulated_date');

  SIMULATED_TODAY = new Date(todayStr);
  SIMULATED_TODAY.setHours(0,0,0,0);
  updateLiveDateTime();

  applyFiltersAndStats();
  logActivity("⏰ Simulated calendar reset back to current actual system time.", "info");
}

function setStatusFilter(filter, el) {
  activeStatusFilter = filter;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  applyFiltersAndStats();
}

function applyFiltersAndStats() {
  const query = document.getElementById('searchBox').value.trim();
  const selectedMonth = document.getElementById('monthFilter').value;
  const targetYear = document.getElementById('targetYearFilter').value;

  // Track sent set
  const sentSet = new Set(JSON.parse(localStorage.getItem('panghat_waSent') || '[]'));

  // Enrich items with computed statistics
  const enriched = DATA.map((item, idx) => {
    const exp = new Date(item.end_date);
    exp.setHours(0,0,0,0);
    const diff = Math.ceil((exp - SIMULATED_TODAY) / 86400000);
    return { ...item, originalIdx: idx, daysLeft: diff, expDate: exp };
  });

  // Calculate Statistics FOR TARGET YEAR (before table filters)
  let totalPremium = 0;
  let activePremiumCount = 0;
  let expiredCount = 0;
  let urgentCount = 0;
  let incomingCount = 0;

  enriched.forEach(item => {
    // Only calculate stats for policies matches target year
    const yearMatch = targetYear === 'all' || (item.expDate.getFullYear() === Number(targetYear));
    if (!yearMatch) return;

    if (item.daysLeft >= 0) {
      totalPremium += Number(item.amount) || 0;
      activePremiumCount++;
    }

    if (item.daysLeft < 0) {
      expiredCount++;
    } else if (item.daysLeft <= 3) {
      urgentCount++;
    } else if (item.daysLeft <= 7) {
      incomingCount++;
    }
  });

  // Update Stats UI
  document.getElementById('premiumValue').textContent = formatCurrency(totalPremium);
  document.getElementById('premiumCount').textContent = `${activePremiumCount} Active Policies`;
  document.getElementById('expiredCount').textContent = expiredCount;
  document.getElementById('urgentCount').textContent = urgentCount;
  document.getElementById('incomingCount').textContent = incomingCount;

  // Perform filtering on dataset
  filteredData = enriched.filter(item => {
    // Year filter check
    const yearMatch = targetYear === 'all' || (item.expDate.getFullYear() === Number(targetYear));
    if (!yearMatch) return false;

    // Month filter check (based on end date)
    const monthMatch = selectedMonth === 'all' || (item.expDate.getMonth() === Number(selectedMonth));
    if (!monthMatch) return false;

    // Search query check
    let queryMatch = true;
    if (query) {
      queryMatch = item.name.includes(query) ||
                   item.vehicle.includes(query) ||
                   item.plate.includes(query) ||
                   item.insurance.includes(query) ||
                   (item.policy_no && item.policy_no.includes(query));
    }
    if (!queryMatch) return false;

    // Status Filter Check
    const bucket = getDaysBucket(item.daysLeft);
    const isSent = sentSet.has(item.originalIdx);

    if (activeStatusFilter === 'all') return true;
    if (activeStatusFilter === 'expired') return bucket === 'expired';
    if (activeStatusFilter === 'today') return bucket === 'today';
    if (activeStatusFilter === '3') return bucket === 'today' || bucket === 'days1' || bucket === 'days3';
    if (activeStatusFilter === '7') return ['today','days1','days3','days7'].includes(bucket);
    if (activeStatusFilter === 'unsent') return item.daysLeft <= 7 && !isSent;

    return true;
  });

  renderTable(sentSet);
  updateSelectedCount();
}

function renderTable(sentSet) {
  const tbody = document.getElementById('registerTableBody');
  const empty = document.getElementById('emptyRegisterState');

  tbody.innerHTML = '';

  if (filteredData.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  filteredData.forEach((item, index) => {
    const bucket = getDaysBucket(item.daysLeft);
    const label = formatDaysLabel(item.daysLeft);
    const isSent = sentSet.has(item.originalIdx);

    // Detect data warnings
    let integrityHelp = '';
    if (!item.phone || item.phone.length < 8) {
      integrityHelp += `<span class="integrity-alert"><i class="fa-solid fa-triangle-exclamation"></i> No Phone</span>`;
    }
    if (!item.policy_no) {
      integrityHelp += `<span class="integrity-alert" style="color:var(--text-muted);"><i class="fa-solid fa-circle-question"></i> No Policy No</span>`;
    }

    const waUrl = buildWhatsAppLink(item);

    const btnWa = isSent
      ? `<a href="${waUrl}" target="_blank" class="btn-wa-action sent" onclick="markAsSent(${item.originalIdx})"><i class="fa-solid fa-circle-check"></i> Resend</a>`
      : `<a href="${waUrl}" target="_blank" class="btn-wa-action" onclick="markAsSent(${item.originalIdx})"><i class="fa-brands fa-whatsapp"></i> Send</a>`;

    // Style provider tag class
    const insClass = item.insurance.toLowerCase().replace(/\s+/g, '');

    // Document Button Builders
    let policyBtn = '';
    if (item.policy_doc) {
      policyBtn = `<button class="btn-doc active-pdf" onclick="downloadDoc(${item.originalIdx}, 'policy')" title="Download Policy PDF: ${item.policy_doc.name}"><i class="fa-solid fa-file-pdf"></i></button>`;
    } else {
      policyBtn = `<button class="btn-doc empty-doc" onclick="openEditModal(${item.originalIdx})" title="No Policy PDF uploaded (Click to edit)"><i class="fa-regular fa-file"></i></button>`;
    }

    let kycBtn = '';
    const hasKyc = (item.kyc_docs && item.kyc_docs.length > 0) || item.kyc_doc;
    if (hasKyc) {
      const kycCount = item.kyc_docs ? item.kyc_docs.length : 1;
      const kycTitle = item.kyc_docs ? item.kyc_docs.map(d => d.name).join(', ') : item.kyc_doc.name;
      kycBtn = `<button class="btn-doc active-kyc" onclick="downloadDoc(${item.originalIdx}, 'kyc')" title="Download KYC Document(s) (${kycCount} files): ${kycTitle}"><i class="fa-solid fa-id-card"></i><span style="font-size:8px;position:absolute;bottom:-2px;right:-2px;background:var(--purple);color:#fff;border-radius:50%;width:13px;height:13px;display:flex;align-items:center;justify-content:center;font-weight:bold;border:1px solid #161b22;">${kycCount}</span></button>`;
    } else {
      kycBtn = `<button class="btn-doc empty-doc" onclick="openEditModal(${item.originalIdx})" title="No KYC Document uploaded (Click to edit)"><i class="fa-regular fa-id-card"></i></button>`;
    }

    const tr = document.createElement('tr');
    tr.id = `row-${item.originalIdx}`;
    tr.innerHTML = `
      <td data-label="Select" style="padding-left:16px;"><input type="checkbox" class="custom-cb row-cb" data-index="${item.originalIdx}" onchange="updateSelectedCount()"></td>
      <td data-label="#" style="font-family:'DM Mono',monospace;color:var(--text-muted);font-size:12px;">${index + 1}</td>
      <td data-label="Client">
        <div class="stack-cell">
          <span class="stack-primary">${item.name}</span>
          <span class="stack-secondary">${item.phone || 'NO PHONE'}</span>
          ${integrityHelp}
        </div>
      </td>
      <td data-label="Vehicle">
        <div class="stack-cell">
          <span style="font-weight:600;color:var(--blue);">${item.vehicle}</span>
          <div class="plate-container" style="margin-top:2px;">
            <div class="plate-ind"><div class="chakra"></div>IND</div>
            <div class="plate-num">${item.plate}</div>
          </div>
        </div>
      </td>
      <td data-label="Policy">
        <div class="stack-cell">
          <div><span class="ins-badge ${insClass}">${item.insurance}</span></div>
          <span class="stack-secondary">${item.policy_no || 'Pending...'}</span>
        </div>
      </td>
      <td data-label="Term">
        <div class="stack-cell" style="font-family:'DM Mono',monospace;font-size:12.5px;">
          <span style="color:var(--text-muted)">Start: ${item.start_date ? formatDate(item.start_date) : 'N/A'}</span>
          <span style="font-weight:600;">End: ${formatDate(item.end_date)}</span>
        </div>
      </td>
      <td data-label="Time Left"><span class="expiry-badge ${bucket}">${label}</span></td>
      <td data-label="Premium" style="font-family:'DM Mono',monospace;font-weight:600;color:var(--accent);">${formatCurrency(item.amount)}</td>
      <td class="remarks-cell" onclick="toggleRemarksExpand(this)">${item.notes || '—'}</td>
      <td>
        <div style="display:flex;gap:6px;justify-content:center;">
          ${policyBtn}
          ${kycBtn}
        </div>
      </td>
      <td>
        <div style="display:flex;gap:6px;">
          ${btnWa}
          <button class="btn btn-secondary" style="padding:6px 10px;" onclick="openEditModal(${item.originalIdx})"><i class="fa-regular fa-pen-to-square"></i></button>
          <button class="btn btn-danger" style="padding:6px 10px;" onclick="deleteEntry(${item.originalIdx})"><i class="fa-regular fa-trash-can"></i></button>
        </div>
      </td>
    `;
    const mobileLabels = ['Select', '#', 'Client', 'Vehicle', 'Policy', 'Term', 'Time Left', 'Premium', 'Remarks', 'Documents', 'Actions'];
    Array.from(tr.children).forEach((cell, cellIndex) => {
      if (!cell.dataset.label) cell.dataset.label = mobileLabels[cellIndex] || '';
    });
    tbody.appendChild(tr);
  });
}

function toggleRemarksExpand(el) {
  el.classList.toggle('expanded');
}

// Bulk sender selection
function toggleSelectAll(master) {
  const checkboxes = document.querySelectorAll('.row-cb');
  checkboxes.forEach(cb => {
    cb.checked = master.checked;
    const row = document.getElementById(`row-${cb.dataset.index}`);
    if (row) {
      if (master.checked) row.classList.add('selected');
      else row.classList.remove('selected');
    }
  });
  updateSelectedCount();
}

function updateSelectedCount() {
  const checkboxes = document.querySelectorAll('.row-cb:checked');
  const count = checkboxes.length;
  document.getElementById('selectedCount').textContent = count;
  document.getElementById('btnSendBulk').disabled = count === 0;
  document.getElementById('btnDeleteSelected').disabled = count === 0;

  // highlight selected rows
  document.querySelectorAll('.row-cb').forEach(cb => {
    const row = document.getElementById(`row-${cb.dataset.index}`);
    if (row) {
      if (cb.checked) row.classList.add('selected');
      else row.classList.remove('selected');
    }
  });
}

// ==============================================
// MESSAGING & BULK DISPATCHER
// ==============================================
function buildWhatsAppLink(item) {
  const template = localStorage.getItem('panghat_whatsapp_template');
  const phone = item.phone.replace(/[^0-9]/g, '');

  const statusStr = item.daysLeft < 0
    ? `has already EXPIRED on ${formatDate(item.end_date)}`
    : item.daysLeft === 0
    ? `expires TODAY!`
    : item.daysLeft === 1
    ? `expires TOMORROW!`
    : `will expire in ${item.daysLeft} days on ${formatDate(item.end_date)}`;

  const msg = template
    .replace(/{name}/g, item.name)
    .replace(/{vehicle}/g, item.vehicle)
    .replace(/{plate}/g, item.plate)
    .replace(/{insurance}/g, item.insurance)
    .replace(/{policy}/g, item.policy_no || 'N/A')
    .replace(/{expiry}/g, formatDate(item.end_date))
    .replace(/{days}/g, item.daysLeft)
    .replace(/{remarks}/g, item.notes || 'None')
    .replace(/{expiry_status}/g, statusStr);

  return `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`;
}

function markAsSent(originalIdx) {
  const sentSet = new Set(JSON.parse(localStorage.getItem('panghat_waSent') || '[]'));
  sentSet.add(originalIdx);
  localStorage.setItem('panghat_waSent', JSON.stringify([...sentSet]));

  logActivity(`💬 WhatsApp opened for client: ${DATA[originalIdx].name}`, "info");

  // Quick timeout to update UI state
  setTimeout(() => applyFiltersAndStats(), 1000);
}

// Bulk sender queue
function triggerBulkSend() {
  const checkboxes = document.querySelectorAll('.row-cb:checked');
  if (checkboxes.length === 0) return;

  const targetIndices = Array.from(checkboxes).map(cb => Number(cb.dataset.index));

  if (confirm(`You have queued ${targetIndices.length} WhatsApp reminders. Because of browser security, we will open them in separate tabs. Please enable popups! Proceed?`)) {
    let index = 0;

    function sendNext() {
      if (index >= targetIndices.length) {
        showToast(`Dispatched all ${targetIndices.length} reminders!`);
        logActivity(`🚀 Bulk WhatsApp: Dispatched all ${targetIndices.length} reminders!`, "info");
        document.getElementById('selectAllCheckbox').checked = false;
        applyFiltersAndStats();
        return;
      }

      const origIdx = targetIndices[index];
      const item = DATA[origIdx];
      const link = buildWhatsAppLink(item);

      window.open(link, '_blank');

      const sentSet = new Set(JSON.parse(localStorage.getItem('panghat_waSent') || '[]'));
      sentSet.add(origIdx);
      localStorage.setItem('panghat_waSent', JSON.stringify([...sentSet]));

      index++;
      setTimeout(sendNext, 2000); // 2 second delay to protect popup blockers
    }
    sendNext();
  }
}

// ==============================================
// EXCEL IMPORT & PARSING ENGINE
// ==============================================
function handleExcelFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  parseExcelFile(file);
}

function parseExcelFile(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rawJson = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      if (rawJson.length === 0) {
        showToast("Excel sheet has no rows of data!", true);
        return;
      }

      // Read columns and prompt mapper
      const mode = document.getElementById('importMode').value;
      const importedRecords = [];

      rawJson.forEach(row => {
        const item = mapExcelRow(row);
        if (item.name && item.phone) {
          importedRecords.push(item);
        }
      });

      if (importedRecords.length === 0) {
        showToast("Could not find rows with valid client Name and Phone columns!", true);
        return;
      }

      if (mode === 'overwrite') {
        DATA = [...importedRecords];
      } else {
        // Append mode
        DATA = [...DATA, ...importedRecords];
      }

      saveDatabase();
      closeModal('importModal');
      applyFiltersAndStats();
      showToast(`Successfully imported ${importedRecords.length} policies from Excel!`);
      logActivity(`📥 Imported file: "${file.name}" with ${importedRecords.length} active rows`, "info");

    } catch(err) {
      showToast("Error parsing Excel file sheet! Check format.", true);
      logActivity(`❌ Import error: ${err.message}`, "err");
    }
  };
  reader.readAsArrayBuffer(file);
}

function mapExcelRow(row) {
  const keys = Object.keys(row);
  const findVal = (possibleHeaders) => {
    const matchedKey = keys.find(k => {
      const cleanKey = k.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      return possibleHeaders.some(ph => cleanKey === ph);
    });
    return matchedKey ? row[matchedKey] : '';
  };

  const name = findVal(['name', 'clientname', 'customername', 'client']);
  const vehicle = findVal(['vehicle', 'vehical', 'model', 'car', 'bike']);
  const plate = findVal(['numberplate', 'plate', 'plateno', 'vehicleno', 'regno', 'numberplate']);
  const insurance = findVal(['insurance', 'inscompany', 'provider', 'company']);

  let startDateRaw = findVal(['date', 'startdate', 'issuedate']);
  let endDateRaw = findVal(['enddate', 'expirydate', 'expdate', 'duedate']);

  const policyNo = findVal(['policyno', 'policy', 'policynumber']);
  const amount = findVal(['amount', 'premium', 'price', 'cost']);
  const phone = findVal(['contactno', 'phone', 'mobile', 'contact', 'phoneno']);
  const notes = findVal(['notes', 'remarks', 'remark', 'note', 'comment']);

  const parseDate = (d) => {
    if (!d) return '';
    if (d instanceof Date) return d.toISOString().split('T')[0];
    if (typeof d === 'number') {
      const date = new Date((d - 25569) * 86400 * 1000);
      return date.toISOString().split('T')[0];
    }
    const cleanStr = String(d).trim();
    if (!cleanStr) return '';

    // Try to parse DD-MM-YYYY
    const dmyMatch = cleanStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmyMatch) {
      const day = dmyMatch[1].padStart(2, '0');
      const month = dmyMatch[2].padStart(2, '0');
      const year = dmyMatch[3];
      return `${year}-${month}-${day}`;
    }

    const parsed = new Date(cleanStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
    return cleanStr;
  };

  return {
    id: generateUniqueId(),
    name: String(name).trim(),
    vehicle: String(vehicle).trim(),
    plate: formatPlateNumber(plate),
    insurance: String(insurance).trim(),
    start_date: parseDate(startDateRaw),
    end_date: parseDate(endDateRaw),
    policy_no: String(policyNo).trim(),
    amount: amount ? Number(amount) : '',
    phone: cleanAndFormatPhone(phone),
    notes: String(notes).trim()
  };
}

// Drag & drop handlers
const dropZone = document.getElementById('excelDropZone');
if (dropZone) {
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) parseExcelFile(file);
  });
  dropZone.addEventListener('click', () => {
    document.getElementById('excelFileInput').click();
  });
}

// ==============================================
// EXPORT & LEDGER BACKUP
// ==============================================
function exportExcel() {
  if (DATA.length === 0) {
    showToast("No data in the ledger to export!", true);
    return;
  }

  try {
    // Format rows for Excel export
    const excelRows = DATA.map((item, index) => ({
      "SR NO.": index + 1,
      "NAME": item.name,
      "VEHICAL": item.vehicle,
      "NUMBER PLATE": item.plate,
      "INSURANCE": item.insurance,
      "POLICY NO.": item.policy_no || '—',
      "START DATE": item.start_date || '—',
      "END DATE": item.end_date,
      "PREMIUM AMOUNT": item.amount || 0,
      "CONTACT NO.": item.phone,
      "REMARKS": item.notes || '—'
    }));

    const worksheet = XLSX.utils.json_to_sheet(excelRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Insurance Register");

    // Save file
    const targetYear = document.getElementById('targetYearFilter').value;
    const filename = `Insurance_Register_Ledger_${targetYear !== 'all' ? targetYear : 'All'}.xlsx`;
    XLSX.writeFile(workbook, filename);

    showToast("Excel spreadsheet downloaded successfully!");
    logActivity(`📤 Exported Excel spreadsheet: "${filename}"`, "info");
  } catch(err) {
    showToast("Failed to compile Excel file!", true);
  }
}

// JSON ledger backup
function downloadJSONBackup() {
  try {
    const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", url);
    dlAnchorElem.setAttribute("download", `LedgerBook_Backup_${new Date().toISOString().split('T')[0]}.json`);
    dlAnchorElem.click();
    URL.revokeObjectURL(url);
    showToast("Backup JSON file generated!");
    logActivity("💾 Exported full JSON database register backup", "info");
  } catch(err) {
    showToast("JSON export failed!", true);
  }
}

// JSON ledger restore/import
function triggerJSONBackupSelect() {
  document.getElementById('jsonBackupInput').click();
}

function handleJSONBackupSelect(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!Array.isArray(parsed)) {
        showToast("Invalid backup file! Must be a list of records.", true);
        return;
      }

      const isValid = parsed.length === 0 || parsed.every(item => item && typeof item === 'object' && ('name' in item) && ('vehicle' in item));
      if (!isValid) {
        showToast("Incorrect ledger backup structure!", true);
        return;
      }

      if (confirm(`You are importing a backup with ${parsed.length} policies. Would you like to OVERWRITE your current database?\n\n(Click 'OK' to OVERWRITE entirely, or click 'Cancel' to MERGE/APPEND records to your current list).`)) {
        // Overwrite
        DATA = parsed;
        saveAllToIndexedDB();
        logActivity(`💾 Restored: Overwrote ledger with ${parsed.length} client files from backup.`, "info");
        showToast(`Database restored with ${parsed.length} records.`);
      } else {
        // Merge/Append
        const initialLength = DATA.length;
        parsed.forEach(newItem => {
          const exists = DATA.some(oldItem =>
            oldItem.name === newItem.name &&
            oldItem.plate === newItem.plate &&
            oldItem.end_date === newItem.end_date
          );
          if (!exists) {
            delete newItem.id;
            DATA.push(newItem);
          }
        });
        saveAllToIndexedDB();
        const addedCount = DATA.length - initialLength;
        logActivity(`💾 Merged: Appended ${addedCount} new client files from backup.`, "info");
        showToast(`Merged: Added ${addedCount} records.`);
      }

      setTimeout(() => applyFiltersAndStats(), 200);
      input.value = '';
    } catch(err) {
      showToast("Failed to parse JSON backup file!", true);
      logActivity(`❌ Restore error: ${err.message}`, "err");
    }
  };
  reader.readAsText(file);
}

// ==============================================
// MESSAGE TEMPLATING SYSTEM
// ==============================================
function openTemplateModal() {
  document.getElementById('messageTemplateInput').value = localStorage.getItem('panghat_whatsapp_template');
  updateTemplatePreview();
  openModal('templateModal');
}

function updateTemplatePreview() {
  const template = document.getElementById('messageTemplateInput').value;
  const mockItem = {
    name: "BHARATBHAI NAGARBHAI PATEL",
    vehicle: "SPLENDER",
    plate: "GJ13SS2914",
    insurance: "NEW INDIA",
    policy_no: "21250131240100002621",
    end_date: "2026-01-01",
    daysLeft: 3,
    notes: "Awaiting client response"
  };

  const statusStr = `will expire in 3 days on ${formatDate(mockItem.end_date)}`;

  const preview = template
    .replace(/{name}/g, mockItem.name)
    .replace(/{vehicle}/g, mockItem.vehicle)
    .replace(/{plate}/g, mockItem.plate)
    .replace(/{insurance}/g, mockItem.insurance)
    .replace(/{policy}/g, mockItem.policy_no)
    .replace(/{expiry}/g, formatDate(mockItem.end_date))
    .replace(/{days}/g, mockItem.daysLeft)
    .replace(/{remarks}/g, mockItem.notes)
    .replace(/{expiry_status}/g, statusStr);

  document.getElementById('templatePreviewBlock').textContent = preview;
}

function saveMessageTemplate() {
  const template = document.getElementById('messageTemplateInput').value;
  localStorage.setItem('panghat_whatsapp_template', template);
  closeModal('templateModal');
  showToast("WhatsApp message template saved successfully!");
  logActivity("💬 Custom WhatsApp reminder message template updated.", "info");
}

function wipeEntireRegister() {
  if (!confirm("WARNING: This will permanently DELETE ALL RECORDS in your ledger book. This cannot be undone. Continue?")) {
    return;
  }

  const finishLocalWipe = () => {
    DATA = [];
    localStorage.removeItem('panghat_insurance_ledger');
    localStorage.removeItem('panghat_insurance_ledger_backup');
    localStorage.removeItem('panghat_waSent');
    const selectAll = document.getElementById('selectAllCheckbox');
    if (selectAll) selectAll.checked = false;
    applyFiltersAndStats();
    showToast("Ledger register wiped successfully!", true);
    logActivity("Wiped entire register ledger of all client policies.", "err");
  };

  const clearIndexedDB = () => {
    if (!dbInstance) {
      finishLocalWipe();
      return;
    }

    const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = finishLocalWipe;
    request.onerror = function() {
      showToast("Failed to clear local database!", true);
    };
  };

  if (cloudSyncActive && firestoreInstance) {
    showToast("Deleting all cloud records...", false);
    (async () => {
      try {
        const snapshot = await firestoreInstance.collection(FIREBASE_COLLECTION).get();
        for (const doc of snapshot.docs) {
          const data = doc.data();
          if (data.policy_doc && data.policy_doc.url) {
            await deleteFileFromFirebaseStorage(data.policy_doc.url);
          }
          if (data.kyc_docs && Array.isArray(data.kyc_docs)) {
            for (const kyc of data.kyc_docs) {
              if (kyc.url) await deleteFileFromFirebaseStorage(kyc.url);
            }
          }
          await doc.ref.delete();
        }
        clearIndexedDB();
      } catch (error) {
        console.error("Cloud wipe failed:", error);
        showToast("Cloud wipe failed. Please try again.", true);
      }
    })();
    return;
  }

  clearIndexedDB();
  return;
  if (confirm("🚨 WARNING: This will permanently DELETE ALL RECORDS in your ledger book! Are you absolutely sure you want to proceed? This cannot be undone!")) {
    DATA = [];
    saveDatabase();
    applyFiltersAndStats();
    showToast("Ledger register wiped successfully!", true);
    logActivity("🗑️ Wiped entire register ledger of all client policies.", "err");
  }
}

// ==============================================
// MODAL OVERLAY UTILITIES
// ==============================================
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// Global modal close handlers
window.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// ==============================================
// SECURITY LOCK & OTP GATEWAY CONTROLLER
// ==============================================
function checkSecurityAccess() {
  localStorage.setItem('PANGHAT_SECURITY_SETUP', 'true');
  localStorage.setItem('PANGHAT_SECURITY_PASSWORD', MASTER_PASSWORD);
  const isSetup = localStorage.getItem('PANGHAT_SECURITY_SETUP') === "true";

  if (!isSetup) {
    // Silently pre-load the user details inside local settings!
    localStorage.setItem('PANGHAT_SECURITY_SETUP', 'true');
    localStorage.setItem('PANGHAT_SECURITY_EMAIL', 'shrey00557@gmail.com');
    localStorage.setItem('PANGHAT_SECURITY_PHONE', '9824500557');
    localStorage.setItem('PANGHAT_SECURITY_PASSWORD', 'Shrey@2711'); // Default Master Backup Unlock Key!
    logActivity("🔑 Security initialized: Credentials loaded for shrey00557@gmail.com & 9824500557.", "info");
  } else if (localStorage.getItem('PANGHAT_SECURITY_PASSWORD') === 'Midasmoneycare@2026' || localStorage.getItem('PANGHAT_SECURITY_PASSWORD') === 'Panghatgiftshop@2026') {
    // Upgrade existing default password to the new requested master key
    localStorage.setItem('PANGHAT_SECURITY_PASSWORD', 'Shrey@2711');
    logActivity("🔑 Security updated: Master Backup Unlock Key changed to Shrey@2711.", "info");
  }

  const overlay = document.getElementById('securityOverlay');
  overlay.style.display = 'flex';
  document.getElementById('securityLockScreen').style.display = 'flex';
  document.getElementById('backupPasswordInput').value = '';
  setTimeout(() => document.getElementById('backupPasswordInput').focus(), 50);

  // Display masked credentials on the dispatch button!
  const maskedEmail = "shr***57@gmail.com";
  const maskedPhone = "******0557";
  const maskedCredentialsLabel = document.getElementById('maskedCredentialsLabel');
  if (maskedCredentialsLabel) maskedCredentialsLabel.textContent = `${maskedEmail} & ${maskedPhone}`;

  // Reset OTP input state
  backToOtpMethods();
}

function submitSecuritySetup() {
  localStorage.setItem('PANGHAT_SECURITY_SETUP', 'true');
  localStorage.setItem('PANGHAT_SECURITY_PASSWORD', MASTER_PASSWORD);
  document.getElementById('securityOverlay').style.display = 'none';
  showToast("Password access enabled successfully!");
  return;
  // Bypassed, but preserved for structural compatibility
  const email = document.getElementById('setupEmail').value.trim();
  const phone = document.getElementById('setupPhone').value.trim();
  const password = document.getElementById('setupPassword').value.trim();

  if (!email || !phone || !password) {
    showToast("Please fill in all security configuration fields!", true);
    return;
  }

  localStorage.setItem('PANGHAT_SECURITY_SETUP', 'true');
  localStorage.setItem('PANGHAT_SECURITY_EMAIL', email);
  localStorage.setItem('PANGHAT_SECURITY_PHONE', phone);
  localStorage.setItem('PANGHAT_SECURITY_PASSWORD', password);

  document.getElementById('securityOverlay').style.display = 'none';
  showToast("Security Lock enabled successfully!");
}

function sendAuthOTP(method) {
  showToast("OTP login is disabled. Use password access only.", true);
  return;
  const otp = Math.floor(100000 + Math.random() * 900000);
  window.ACTIVE_OTP = otp;
  window.ACTIVE_OTP_TIME = Date.now();

  const regEmail = localStorage.getItem('PANGHAT_SECURITY_EMAIL') || 'shrey00557@gmail.com';
  const regPhone = localStorage.getItem('PANGHAT_SECURITY_PHONE') || '9824500557';

  let sentRealEmail = false;
  let sentRealSms = false;

  // 1. EmailJS (Real Email OTP)
  const emailJsPublicKey = localStorage.getItem('PANGHAT_EMAILJS_PUBLIC_KEY');
  const emailJsServiceId = localStorage.getItem('PANGHAT_EMAILJS_SERVICE_ID');
  const emailJsTemplateId = localStorage.getItem('PANGHAT_EMAILJS_TEMPLATE_ID');

  if (emailJsPublicKey && emailJsServiceId && emailJsTemplateId) {
    try {
      sentRealEmail = true;
      emailjs.init(emailJsPublicKey);
      emailjs.send(emailJsServiceId, emailJsTemplateId, {
        to_email: regEmail,
        otp_code: otp,
        company_name: "Panghat Gift Shop"
      }).then(function() {
        logActivity("📩 Real Email OTP sent successfully to shrey00557@gmail.com via EmailJS API.", "info");
      }, function(err) {
        console.error("EmailJS failed: ", err);
        logActivity("❌ EmailJS failed to send real email. Fallback active.", "err");
      });
    } catch(ex) {
      console.error("EmailJS init failed: ", ex);
    }
  }

  // 2. Twilio (Real SMS/WhatsApp OTP)
  const twilioSid = localStorage.getItem('PANGHAT_TWILIO_SID');
  const twilioToken = localStorage.getItem('PANGHAT_TWILIO_TOKEN');
  const twilioNumber = localStorage.getItem('PANGHAT_TWILIO_NUMBER');

  if (twilioSid && twilioToken && twilioNumber) {
    try {
      sentRealSms = true;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
      const auth = btoa(`${twilioSid}:${twilioToken}`);
      const body = new URLSearchParams();
      body.append('To', regPhone.startsWith('+') ? regPhone : '+91' + regPhone);
      body.append('From', twilioNumber);
      body.append('Body', `Panghat Gift Shop verification code: ${otp}`);

      fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body
      }).then(response => {
        if (response.ok) {
          logActivity("📱 Real SMS OTP sent successfully to +919824500557 via Twilio REST API.", "info");
        } else {
          logActivity("❌ Twilio API returned error while sending SMS.", "err");
        }
      }).catch(err => {
        console.error("Twilio request failed: ", err);
      });
    } catch(ex) {
      console.error("Twilio send failed: ", ex);
    }
  }

  // Toast & Local Mode alert
  document.getElementById('otpStatusAlert').textContent = `Verification OTP sent to your registered Email & Phone!`;

  // Trigger simulated fallback if no API keys configured
  if (!sentRealEmail && !sentRealSms) {
    showToast(`🔑 Local Mode OTP: ${otp}`, false);
    setTimeout(() => {
      alert(`🔑 SECURITY NOTIFICATION (Local Offline Mode)\n\nAn OTP verification code has been generated and dispatched to BOTH registered devices:\n📧 Email: shrey00557@gmail.com\n📱 Mobile: 9824500557\n\n👉 Code: ${otp}\n\n(Type this code in the input cells to unlock Panghat Gift Shop. To trigger real messages, configure API keys in Settings).`);
    }, 100);
  } else {
    showToast("Verification code dispatched to both channels!");
  }

  // Toggle screens
  document.getElementById('otpMethodsBlock').style.display = 'none';
  document.getElementById('otpInputBlock').style.display = 'flex';

  // Clear cell inputs & focus
  for (let i = 1; i <= 6; i++) {
    const cell = document.getElementById(`otpCell${i}`);
    cell.value = '';
    cell.disabled = false;
  }
  document.getElementById('otpCell1').focus();
}

function handleOtpCellInput(input, index) {
  showToast("OTP login is disabled. Use password access only.", true);
  return;
  // Advance to next input cell on keystroke
  if (input.value.length === 1) {
    if (index < 6) {
      document.getElementById(`otpCell${index + 1}`).focus();
    } else {
      // Auto submit on last cell
      verifyAuthOTP();
    }
  } else if (input.value.length === 0) {
    // Move backwards on backspace
    if (index > 1) {
      document.getElementById(`otpCell${index - 1}`).focus();
    }
  }
}

function verifyAuthOTP() {
  showToast("OTP login is disabled. Use password access only.", true);
  return;
  let enteredCode = '';
  for (let i = 1; i <= 6; i++) {
    enteredCode += document.getElementById(`otpCell${i}`).value.trim();
  }

  if (enteredCode.length < 6) {
    showToast("Please enter the complete 6-digit OTP code!", true);
    return;
  }

  const elapsed = (Date.now() - window.ACTIVE_OTP_TIME) / 1000;
  if (elapsed > 300) { // 5 mins limit
    showToast("OTP has expired! Request a new code.", true);
    return;
  }

  if (enteredCode === String(window.ACTIVE_OTP)) {
    // Authenticated!
    document.getElementById('securityOverlay').style.display = 'none';
    showToast("Registry unlocked successfully!");
    logActivity("🔓 Authentication cleared. Access granted via OTP verification.", "info");
  } else {
    showToast("Invalid verification code! Try again.", true);

    // Flash cells in red to indicate error
    for (let i = 1; i <= 6; i++) {
      const cell = document.getElementById(`otpCell${i}`);
      cell.style.borderColor = 'var(--red)';
      cell.style.boxShadow = '0 0 8px var(--red-dim)';
      setTimeout(() => {
        cell.style.borderColor = 'var(--border)';
        cell.style.boxShadow = 'none';
        cell.value = '';
      }, 800);
    }
    document.getElementById('otpCell1').focus();
  }
}

function verifyBackupPassword() {
  const enteredPass = document.getElementById('backupPasswordInput').value.trim();
  const actualPass = localStorage.getItem('PANGHAT_SECURITY_PASSWORD');

  if (!enteredPass) {
    showToast("Enter your backup master password!", true);
    return;
  }

  if (enteredPass === actualPass) {
    document.getElementById('securityOverlay').style.display = 'none';
    showToast("Registry unlocked successfully!");
    logActivity("🔓 Access granted via Master Key verification.", "info");
    document.getElementById('backupPasswordInput').value = '';
  } else {
    showToast("Incorrect backup master password!", true);
    const cell = document.getElementById('backupPasswordInput');
    cell.style.borderColor = 'var(--red)';
    setTimeout(() => { cell.style.borderColor = 'var(--border)'; }, 800);
  }
}

function backToOtpMethods() {
  const otpInputBlock = document.getElementById('otpInputBlock');
  const otpMethodsBlock = document.getElementById('otpMethodsBlock');
  if (otpInputBlock) otpInputBlock.style.display = 'none';
  if (otpMethodsBlock) otpMethodsBlock.style.display = 'flex';
}

// Security API Settings Modal controls
// Security API Settings Modal controls
function openSecuritySettingsModal() {
  // Load owner details
  document.getElementById('settingsOwnerPassword').value = localStorage.getItem('PANGHAT_SECURITY_PASSWORD') || MASTER_PASSWORD;

  openModal('securitySettingsModal');
}

function saveSecuritySettings() {
  const password = document.getElementById('settingsOwnerPassword').value.trim();

  if (password !== MASTER_PASSWORD) {
    showToast("Master password must remain shrey@2711.", true);
    return;
  }

  // Save credentials
  localStorage.setItem('PANGHAT_SECURITY_PASSWORD', MASTER_PASSWORD);

  closeModal('securitySettingsModal');
  showToast("Security and cloud settings saved successfully!");
  logActivity("🔐 Credentials Update: Gateway keys and owner configuration modified.", "info");
}

// ==============================================
// FIREBASE CLOUD SYNC & SECURE AUTH CORE ENGINE
// ==============================================
let firebaseAppInstance = null;
let firestoreInstance = null;
let firebaseStorageInstance = null;
let firebaseAuthInstance = null;
let cloudSyncActive = false;
let firebaseUnsubscribeListener = null;

function initFirebaseConnection(configChanged = false) {
  const enabled = FIREBASE_CONFIG.enabled;

  const badge = document.getElementById('cloudSyncStatusBadge');

  if (!enabled) {
    cloudSyncActive = false;
    if (badge) {
      badge.innerHTML = `<i class="fa-solid fa-cloud"></i> <span>Local Mode</span>`;
      badge.style.background = 'rgba(100, 116, 139, 0.08)';
      badge.style.color = 'var(--text-muted)';
      badge.style.borderColor = 'var(--border)';
    }

    if (firebaseUnsubscribeListener) {
      firebaseUnsubscribeListener();
      firebaseUnsubscribeListener = null;
    }

    if (configChanged) {
      logActivity("ℹ️ Cloud Sync disabled. Offline IndexedDB mode active.", "info");
      loadAllRecordsFromDB(); // Reload local records to restore standard flow
    }
    return;
  }

  if (badge) {
    badge.innerHTML = `<i class="fa-solid fa-rotate fa-spin" style="color:var(--accent);"></i> <span style="color:var(--accent);">Syncing...</span>`;
    badge.style.background = 'var(--accent-glow)';
    badge.style.borderColor = 'var(--accent)';
  }

  try {
    const firebaseConfig = {
      apiKey: FIREBASE_CONFIG.apiKey,
      authDomain: FIREBASE_CONFIG.authDomain,
      projectId: FIREBASE_CONFIG.projectId,
      storageBucket: FIREBASE_CONFIG.storageBucket,
      messagingSenderId: FIREBASE_CONFIG.messagingSenderId,
      appId: FIREBASE_CONFIG.appId,
      measurementId: FIREBASE_CONFIG.measurementId
    };

    if (firebase.apps.length > 0) {
      // Reinitialize if config changed or app is already loaded
      Promise.all(firebase.apps.map(app => app.delete())).then(() => {
        initializeFirebaseApp(firebaseConfig);
      }).catch(err => {
        console.error("Reinit deletion failed:", err);
        initializeFirebaseApp(firebaseConfig);
      });
    } else {
      initializeFirebaseApp(firebaseConfig);
    }
  } catch (error) {
    console.error("Firebase startup error:", error);
    markSyncFailed();
  }
}

function initializeFirebaseApp(config) {
  const badge = document.getElementById('cloudSyncStatusBadge');
  try {
    firebaseAppInstance = firebase.initializeApp(config);
    firestoreInstance = firebase.firestore();
    firebaseStorageInstance = firebase.storage();
    firebaseAuthInstance = firebase.auth();

    // Authenticate anonymously (Automatic JWT issuance)
    firebaseAuthInstance.signInAnonymously()
      .then(() => {
        cloudSyncActive = true;
        if (badge) {
          badge.innerHTML = `<i class="fa-solid fa-cloud-arrow-up" style="color:var(--orange);"></i> <span style="color:var(--orange);">Cloud Synced</span>`;
          badge.style.background = 'rgba(249, 115, 22, 0.08)';
          badge.style.borderColor = 'var(--orange)';
        }
        logActivity("☁️ Cloud Sync active: Session authorized via serverless JWT.", "info");

        // Sync local caches to Cloud on launch
        bulkSyncLocalToFirebase();

        // Subscribe to live Firestore updates
        subscribeToFirebaseLiveUpdates();
      })
      .catch((error) => {
        console.error("Firebase auth check failed:", error);
        markSyncFailed();
      });
  } catch (ex) {
    console.error("Firebase config execution failed:", ex);
    markSyncFailed();
  }
}

function markSyncFailed() {
  cloudSyncActive = false;
  const badge = document.getElementById('cloudSyncStatusBadge');
  if (badge) {
    badge.innerHTML = `<i class="fa-solid fa-cloud-exclamation" style="color:var(--red);"></i> <span style="color:var(--red);">Sync Failed</span>`;
    badge.style.background = 'var(--red-dim)';
    badge.style.borderColor = 'var(--red)';
  }
  logActivity("❌ Cloud Sync offline fallback: Check keys and network status.", "err");
}

function subscribeToFirebaseLiveUpdates() {
  if (firebaseUnsubscribeListener) {
    firebaseUnsubscribeListener();
  }

  firebaseUnsubscribeListener = firestoreInstance.collection(FIREBASE_COLLECTION)
    .onSnapshot((snapshot) => {
      if (dbInstance) {
        const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        let hasChanges = false;

        snapshot.docChanges().forEach((change) => {
          const doc = change.doc;
          const cloudItem = doc.data();
          cloudItem.id = doc.id; // Inject firestore document ID (unique string)
          const docIdStr = String(cloudItem.id);

          // Exclude legacy 2025 entries
          const expYear = new Date(cloudItem.end_date).getFullYear();
          if (expYear === 2025) {
            const localIndex = DATA.findIndex(item => String(item.id) === docIdStr);
            if (localIndex > -1) {
              DATA.splice(localIndex, 1);
            }
            store.delete(cloudItem.id);
            hasChanges = true;
            // Clean up from Firestore
            firestoreInstance.collection(FIREBASE_COLLECTION).doc(doc.id).delete().catch(()=>{});
            return;
          }

          if (change.type === "added" || change.type === "modified") {
            if (uploadingDocIds.has(docIdStr)) {
              // Retain local unsynced copy while uploading is in progress
              return;
            }

            const localIndex = DATA.findIndex(item => String(item.id) === docIdStr);
            const localItem = localIndex > -1 ? DATA[localIndex] : null;

            let mergedItem = { ...cloudItem };
            if (localItem) {
              if (cloudItem.policy_doc && cloudItem.policy_doc.localOnly) {
                if (localItem.policy_doc && localItem.policy_doc.data) {
                  mergedItem.policy_doc = {
                    ...cloudItem.policy_doc,
                    data: localItem.policy_doc.data
                  };
                }
              }

              if (Array.isArray(cloudItem.kyc_docs)) {
                mergedItem.kyc_docs = cloudItem.kyc_docs.map((cloudKyc, kIdx) => {
                  if (cloudKyc && cloudKyc.localOnly) {
                    const localKyc = Array.isArray(localItem.kyc_docs) ? localItem.kyc_docs[kIdx] : null;
                    if (localKyc && localKyc.data) {
                      return {
                        ...cloudKyc,
                        data: localKyc.data
                      };
                    }
                  }
                  return cloudKyc;
                });
                mergedItem.kyc_doc = mergedItem.kyc_docs.length > 0 ? mergedItem.kyc_docs[0] : null;
              }
            }

            if (localIndex > -1) {
              DATA[localIndex] = mergedItem;
            } else {
              DATA.push(mergedItem);
            }

            store.put(mergedItem);
            hasChanges = true;
          }

          if (change.type === "removed") {
            const localIndex = DATA.findIndex(item => String(item.id) === docIdStr);
            if (localIndex > -1) {
              DATA.splice(localIndex, 1);
            }
            store.delete(cloudItem.id);
            hasChanges = true;
          }
        });

        transaction.oncomplete = function() {
          if (hasChanges) {
            applyFiltersAndStats();
          }
        };
      } else {
        // Fallback if dbInstance is not connected yet, update array only
        snapshot.docChanges().forEach((change) => {
          const doc = change.doc;
          const cloudItem = doc.data();
          cloudItem.id = doc.id;
          const docIdStr = String(cloudItem.id);

          const expYear = new Date(cloudItem.end_date).getFullYear();
          if (expYear === 2025) return;

          if (change.type === "added" || change.type === "modified") {
            const localIndex = DATA.findIndex(item => String(item.id) === docIdStr);
            if (localIndex > -1) {
              DATA[localIndex] = cloudItem;
            } else {
              DATA.push(cloudItem);
            }
          }
          if (change.type === "removed") {
            const localIndex = DATA.findIndex(item => String(item.id) === docIdStr);
            if (localIndex > -1) {
              DATA.splice(localIndex, 1);
            }
          }
        });
        applyFiltersAndStats();
      }
    }, (error) => {
      console.error("Firestore listening failed:", error);
    });
}

async function bulkSyncLocalToFirebase() {
  if (!cloudSyncActive || !dbInstance) return;

  const transaction = dbInstance.transaction([STORE_NAME], 'readonly');
  const store = transaction.objectStore(STORE_NAME);

  store.getAll().onsuccess = async function(e) {
    const localRecords = e.target.result || [];
    if (localRecords.length === 0) return;

    try {
      const batch = firestoreInstance.batch();
      let syncAdded = 0;

      for (const record of localRecords) {
        const querySnapshot = await firestoreInstance.collection(FIREBASE_COLLECTION)
          .where('plate', '==', record.plate)
          .where('end_date', '==', record.end_date)
          .get();

        if (querySnapshot.empty) {
          const newDocRef = firestoreInstance.collection(FIREBASE_COLLECTION).doc();
          const cloudEntry = { ...record };
          delete cloudEntry.id;

          // Migrate local base64 attachments to Cloud Storage automatically
          if (record.policy_doc && record.policy_doc.data && !record.policy_doc.url) {
            const url = await uploadFileToFirebaseStorage(newDocRef.id, record.policy_doc, 'policy_doc');
            cloudEntry.policy_doc = { name: record.policy_doc.name, type: record.policy_doc.type, url };
          }

          if (record.kyc_docs && Array.isArray(record.kyc_docs)) {
            const cloudKycDocs = [];
            for (let i = 0; i < record.kyc_docs.length; i++) {
              const kyc = record.kyc_docs[i];
              if (kyc.data && !kyc.url) {
                const url = await uploadFileToFirebaseStorage(newDocRef.id, kyc, `kyc_doc_${i}`);
                cloudKycDocs.push({ name: kyc.name, type: kyc.type, url });
              } else {
                cloudKycDocs.push(kyc);
              }
            }
            cloudEntry.kyc_docs = cloudKycDocs;
            cloudEntry.kyc_doc = cloudKycDocs.length > 0 ? cloudKycDocs[0] : null;
          }

          batch.set(newDocRef, cloudEntry);
          syncAdded++;
        }
      }

      if (syncAdded > 0) {
        await batch.commit();
        logActivity(`☁️ Cloud Auto-Migrator: Transferred ${syncAdded} local records to cloud.`, "info");
      }
    } catch (err) {
      console.error("Auto sync transfer error:", err);
    }
  };
}

async function uploadFileToFirebaseStorage(policyId, fileObj, customName) {
  if (!firebaseStorageInstance) return "";
  try {
    const storageRef = firebaseStorageInstance.ref();
    const fileRef = storageRef.child(`${FIREBASE_STORAGE_ROOT}/${policyId}/${customName}`);
    const uploadTask = await fileRef.putString(fileObj.data, 'data_url');
    const downloadUrl = await uploadTask.ref.getDownloadURL();
    return downloadUrl;
  } catch (error) {
    console.error("Firebase Storage file upload failed:", error);
    return "";
  }
}

async function deleteFileFromFirebaseStorage(fileUrl) {
  if (!firebaseStorageInstance) return;
  try {
    const fileRef = firebaseStorageInstance.refFromURL(fileUrl);
    await fileRef.delete();
  } catch (error) {
    console.error("Firebase Storage file delete failed:", error);
  }
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {


  initDatabase();
  updateSimulatedDate();
  checkSecurityAccess();

  // Start live clock - updates every second
  updateLiveDateTime();
  setInterval(updateLiveDateTime, 1000);
});
