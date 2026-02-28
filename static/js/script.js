// ========================================================
// 1. CONFIGURATION & DATABASE SETUP (via Flask Proxy)
// ========================================================
class TursoDB {
    constructor() {
        this.proxyUrl = '/db';
    }

    async executeSql(sql, args = []) {
        try {
            const response = await fetch(this.proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql, args })
            });

            if (!response.ok) {
                const errBody = await response.text();
                throw new Error(`DB Error: ${response.status} ${errBody}`);
            }

            const result = await response.json();

            // Map rows to objects
            if (!result.cols || !result.rows) return { data: [] };

            const cols = result.cols.map(c => c.name);
            const data = result.rows.map(row => {
                let obj = {};
                row.forEach((val, i) => {
                    // Turso v2 returns values as objects like {type: "text", value: "..."}
                    // Extract just the value, or null if it's a null type
                    if (val && typeof val === 'object') {
                        // Turso v2 returns values as objects like {type: "text", value: "..."}
                        if ('value' in val) {
                            obj[cols[i]] = (val.type === 'null') ? null : val.value;
                        } else {
                            // Fallback if it's some other object
                            obj[cols[i]] = JSON.stringify(val);
                        }
                    } else {
                        obj[cols[i]] = val;
                    }
                });
                return obj;
            });

            return { data };
        } catch (e) {
            console.error("Database Proxy Error:", e);
            return { data: null, error: e.message };
        }
    }

    from(table) {
        const db = this;
        return {
            _filters: [],
            _limit: null,
            _action: 'read',
            _payload: null,
            _table: table,
            _db: db,

            eq(col, val) { this._filters.push({ col, val, op: '=' }); return this; },
            gte(col, val) { this._filters.push({ col, val, op: '>=' }); return this; },
            lte(col, val) { this._filters.push({ col, val, op: '<=' }); return this; },
            limit(n) { this._limit = n; return this; },

            _buildWhere() {
                if (this._filters.length === 0) return { sql: "", args: [] };
                const sql = " WHERE " + this._filters.map(f => `${f.col} ${f.op} ?`).join(" AND ");
                const args = this._filters.map(f => f.val);
                return { sql, args };
            },

            select: function (columns = '*') {
                this._action = 'read';
                return this;
            },

            insert: function (rows) {
                this._action = 'insert';
                this._payload = rows;
                return this;
            },

            update: function (row) {
                this._action = 'update';
                this._payload = row;
                return this;
            },

            delete: function () {
                this._action = 'delete';
                return this;
            },

            upsert: function (row) {
                this._action = 'upsert';
                this._payload = row;
                return this;
            },

            execute: async function () {
                if (this._action === 'read') {
                    const { sql, args } = this._buildWhere();
                    let fullSql = `SELECT * FROM ${this._table}${sql}`;
                    if (this._limit) fullSql += ` LIMIT ${this._limit}`;
                    return await this._db.executeSql(fullSql, args);
                }

                if (this._action === 'insert') {
                    const items = Array.isArray(this._payload) ? this._payload : [this._payload];
                    const results = [];
                    for (const row of items) {
                        const keys = Object.keys(row);
                        const sql = `INSERT INTO ${this._table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
                        results.push(await this._db.executeSql(sql, Object.values(row)));
                    }
                    return { data: results, error: results.find(r => r.error) };
                }

                if (this._action === 'update') {
                    const keys = Object.keys(this._payload);
                    const { sql: whereSql, args: whereArgs } = this._buildWhere();
                    const sql = `UPDATE ${this._table} SET ${keys.map(k => `${k} = ?`).join(", ")}${whereSql}`;
                    return await this._db.executeSql(sql, [...Object.values(this._payload), ...whereArgs]);
                }

                if (this._action === 'delete') {
                    const { sql, args } = this._buildWhere();
                    return await this._db.executeSql(`DELETE FROM ${this._table}${sql}`, args);
                }

                if (this._action === 'upsert') {
                    const keys = Object.keys(this._payload);
                    let conflictKey = 'id';
                    if (this._table === 'system_settings') conflictKey = 'setting_key';
                    const setClause = keys.map(k => `${k} = EXCLUDED.${k}`).join(", ");
                    const sql = `INSERT INTO ${this._table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")}) 
                                 ON CONFLICT(${conflictKey}) DO UPDATE SET ${setClause}`;
                    return await this._db.executeSql(sql, Object.values(this._payload));
                }
            },

            single: async function () {
                const res = await this.execute();
                return { data: res.data ? res.data[0] : null, error: res.error };
            },

            then: function (resolve, reject) {
                return this.execute().then(resolve, reject);
            }
        };
    }
}

const db = new TursoDB();

const CREDENTIALS = {
    'IT Support': { pass: 'Sys@Admin2025', role: 'it_admin' },
    'Admin': { pass: 'Subhalaxmipet@2025', role: 'super_admin' },
    'Smart Admin': { pass: 'Subhalaxmipet@2025', role: 'admin' }
};

const app = {
    // --- APP STATE ---
    userRole: null,
    systemLocked: false,
    faceModelsLoaded: false,

    // Registration Data
    biometricDescriptor: null,
    currentPhoto: null,
    labeledDescriptors: [],

    // Dashboard State
    currentDate: new Date(),
    selectedDateStr: new Date().toISOString().split('T')[0],
    isOverallView: true,

    // Scanner State
    lastScanMap: new Map(),
    scanLock: new Map(), // Prevents rapid-fire duplicate scans
    SCAN_COOLDOWN: 60000, // 1 Minute logic cooldown
    isOnline: navigator.onLine,

    charts: { plant: null, efficiency: null },

    // ========================================================
    // 2. INITIALIZATION
    // ========================================================
    init: async () => {
        app.updateDate();
        app.fetchWeather();
        setInterval(app.updateDate, 60000);
        setInterval(app.fetchWeather, 300000);
        app.setupNetworkListeners();
        await app.checkSystemStatus();
        app.attachListeners();

        // Populate employee dropdown for reports
        app.populateReportEmployees();

        // Load AI Models
        try {
            const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
            await Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL), // Essential for Kiosk
                faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
                faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
                faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
            ]);

            app.faceModelsLoaded = true;
            console.log("AI Models Loaded");
            app.loadFaceData();
        } catch (e) { console.error("Model Error:", e); }
    },

    attachListeners: () => {
        const loginForm = document.getElementById('login-form');
        if (loginForm) loginForm.addEventListener('submit', app.handleLogin);

        const lockToggle = document.getElementById('system-lock-toggle');
        if (lockToggle) lockToggle.addEventListener('change', app.toggleSystemLock);

        // --- NEW: Advanced Reports Listeners ---
        const advRepBtn = document.getElementById('advancedReportsBtn');
        if (advRepBtn) advRepBtn.addEventListener('click', app.openAdvancedReports);

        const closeRepBtn = document.getElementById('closeReportsBtn');
        if (closeRepBtn) closeRepBtn.addEventListener('click', app.closeAdvancedReports);
    },

    speak: (text) => {
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'en-IN';
            utterance.rate = 1.0;
            window.speechSynthesis.speak(utterance);
        }
    },

    // ========================================================
    // 3. AUTHENTICATION & SECURITY
    // ========================================================
    checkSystemStatus: async () => {
        const { data } = await db.from('system_settings').select('*').eq('setting_key', 'system_lock').single();
        if (data) {
            app.systemLocked = (data.setting_value === 'locked');
            const badge = document.getElementById('system-status-badge');
            if (badge) {
                badge.className = app.systemLocked ? 'badge bg-danger' : 'badge bg-success-subtle text-success border border-success';
                badge.innerText = app.systemLocked ? 'System Maintenance' : 'System Online';
            }
            const toggle = document.getElementById('system-lock-toggle');
            if (toggle) toggle.checked = !app.systemLocked;
        }
    },

    handleLogin: async (e) => {
        e.preventDefault();
        const user = document.getElementById('login-user').value;
        const pass = document.getElementById('login-pass').value;

        // 1. IT Admin Bypass
        if (CREDENTIALS[user] && CREDENTIALS[user].role === 'it_admin' && CREDENTIALS[user].pass === pass) {
            app.userRole = 'it_admin';
            app.loadDashboard();
            return;
        }

        // 2. License Check (Time Bomb)
        const { data: lic } = await db.from('system_settings').select('*').eq('setting_key', 'license_expiry').single();
        if (lic && lic.setting_value) {
            if (new Date() > new Date(lic.setting_value)) {
                return alert("⚠️ LICENSE EXPIRED\n\nPlease contact Codentra Innovations to renew access.");
            }
        }

        // 3. Maintenance Lock
        if (app.systemLocked) return alert("System is currently locked for maintenance.");

        // 4. Client Login
        if (CREDENTIALS[user] && CREDENTIALS[user].pass === pass) {
            app.userRole = CREDENTIALS[user].role;
            app.loadDashboard();
        } else {
            alert("Invalid Credentials");
        }
    },

    loadDashboard: () => {
        document.getElementById('login-section').classList.add('d-none');
        document.getElementById('dashboard-layout').classList.remove('d-none');
        document.getElementById('dashboard-layout').classList.add('d-flex');

        if (app.userRole === 'it_admin') {
            document.getElementById('it-admin-view').classList.remove('d-none');
        } else {
            document.getElementById('admin-view').classList.remove('d-none');
            app.fetchWeather();
            app.loadDesignations(); // Load filter dropdowns
            app.loadOverallCharts();
            app.refreshDashboardData();
        }
    },

    logout: () => location.reload(),

    // ========================================================
    // 4. REPORTING (PDF & EXCEL - PROFESSIONAL GRADE)
    // ========================================================

    // --- NEW: Advanced Reports View Switching ---
    openAdvancedReports: () => {
        console.log("Opening Advanced Reports...");

        // Hide the main Dashboard Layout
        const dashboard = document.getElementById('dashboard-layout');
        if (dashboard) dashboard.classList.add('d-none');

        // Show the Reports Section (Ensure you have a div with id="reportsSection" in your HTML)
        const reportsSection = document.getElementById('reportsSection');
        if (reportsSection) {
            reportsSection.classList.remove('d-none');

            // Set default dates to Today
            const today = app.formatDate(new Date());
            const startInput = document.getElementById('adv-start-date');
            const endInput = document.getElementById('adv-end-date');
            if (startInput) startInput.value = today;
            if (endInput) endInput.value = today;

            // Load specific data for this view
            app.loadAdvancedReportStats();
        } else {
            alert("Error: 'reportsSection' div not found in HTML.");
        }
    },

    closeAdvancedReports: () => {
        // Hide Reports
        const reportsSection = document.getElementById('reportsSection');
        if (reportsSection) reportsSection.classList.add('d-none');

        // Show Dashboard
        const dashboard = document.getElementById('dashboard-layout');
        if (dashboard) dashboard.classList.remove('d-none');
    },

    loadAdvancedReportStats: async () => {
        const type = document.getElementById('adv-report-type').value;
        const grain = document.getElementById('adv-report-grain').value;
        const start = document.getElementById('adv-start-date').value;
        const end = document.getElementById('adv-end-date').value;
        const empId = document.getElementById('adv-report-emp').value;
        const container = document.getElementById('adv-report-content');

        if (!start) return alert("Please select a start date.");
        container.innerHTML = '<div class="text-center p-5"><div class="spinner-border text-primary"></div><p class="mt-2">Generating Report...</p></div>';

        let startDate = new Date(start);
        let endDate = end ? new Date(end) : new Date(start);

        if (grain === 'weekly') {
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 6);
        } else if (grain === 'monthly') {
            startDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
            endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
        } else if (grain === 'quarterly') {
            const q = Math.floor(startDate.getMonth() / 3);
            startDate = new Date(startDate.getFullYear(), q * 3, 1);
            endDate = new Date(startDate.getFullYear(), (q + 1) * 3, 0);
        } else if (grain === 'yearly') {
            startDate = new Date(startDate.getFullYear(), 0, 1);
            endDate = new Date(startDate.getFullYear(), 11, 31);
        }

        const startStr = app.formatDate(startDate);
        const endStr = app.formatDate(endDate);

        if (type === 'matrix') {
            return app.loadMatrixReport(startStr, endStr, empId);
        }

        // --- Original Summary logic ---
        const { data: logs } = await db.from('attendance').select('*');
        let { data: emps } = await db.from('employees').select('*');
        if (!logs || !emps) return container.innerHTML = "No data available.";

        if (empId !== 'all') {
            emps = emps.filter(e => e.id == empId);
        }

        const filteredLogs = logs.filter(l => l.date >= startStr && l.date <= endStr);

        container.innerHTML = `
            <div class="row g-3">
                <div class="col-md-4">
                    <div class="card bg-primary text-white p-3 border-0 shadow-sm">
                        <h3 class="fw-bold">${filteredLogs.length}</h3>
                        <small class="opacity-75">Total Attendances</small>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card bg-success text-white p-3 border-0 shadow-sm">
                        <h3 class="fw-bold">${[...new Set(filteredLogs.map(l => l.emp_id))].length}</h3>
                        <small class="opacity-75">Unique Staff Present</small>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card bg-info text-white p-3 border-0 shadow-sm">
                        <h3 class="fw-bold">${grain.toUpperCase()}</h3>
                        <small class="opacity-75">Report Frequency</small>
                    </div>
                </div>
            </div>
            <div class="mt-4 table-responsive bg-white p-3 rounded shadow-sm">
                <table class="table table-sm table-hover align-middle">
                    <thead class="table-light">
                        <tr><th>Staff</th><th>ID</th><th>Unit</th><th>Days Present</th></tr>
                    </thead>
                    <tbody>
                        ${emps.slice(0, 20).map(e => {
            const count = filteredLogs.filter(l => l.emp_id == e.id).length;
            return `<tr><td><div class="fw-bold">${e.name}</div><div class="small text-muted">${e.designation || '-'}</div></td><td><code>${e.id}</code></td><td>${e.unit || '-'}</td><td><span class="badge bg-primary">${count}</span></td></tr>`;
        }).join('')}
                    </tbody>
                </table>
                <p class="small text-muted text-center mt-3">Preview showing top 20 employees. Use <b>Export Excel</b> for full details.</p>
            </div>
        `;
    },

    loadMatrixReport: async (startStr, endStr, empId = 'all') => {
        const container = document.getElementById('adv-report-content');
        let { data: emps } = await db.from('employees').select('*');
        const { data: logs } = await db.from('attendance').select('*');
        const { data: leaves } = await db.from('leave_master').select('*');
        const { data: holidays } = await db.from('holiday_master').select('*');

        if (!emps) return container.innerHTML = "No staff found.";

        if (empId !== 'all') {
            emps = emps.filter(e => e.id == empId);
        }

        // Generate date list
        const days = [];
        let curr = new Date(startStr);
        const end = new Date(endStr);
        while (curr <= end) {
            days.push(app.formatDate(curr));
            curr.setDate(curr.getDate() + 1);
        }

        let html = `
            <div class="matrix-container bg-white p-3 rounded shadow-sm table-responsive">
                <style>
                    .matrix-table { font-size: 0.8rem; border-collapse: separate; border-spacing: 0; width: 100%; }
                    .matrix-table th, .matrix-table td { border: 1px solid #dee2e6; padding: 4px; text-align: center; min-width: 30px; background: white; }
                    
                    /* Sticky Left: Employee Name */
                    .matrix-table .emp-name { 
                        text-align: left; 
                        width: 180px; 
                        min-width: 180px;
                        max-width: 180px;
                        position: sticky; 
                        left: 0; 
                        background: #ffffff !important; 
                        z-index: 20; 
                        font-weight: bold;
                        border-right: 2px solid #6f42c1 !important;
                        box-shadow: 2px 0 5px rgba(0,0,0,0.1);
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    }
                    
                    /* Sticky Right: Summary Columns */
                    .matrix-table .sticky-right {
                        position: sticky;
                        right: 0;
                        background: #f8f9fa !important;
                        z-index: 15;
                        border-left: 2px solid #6f42c1 !important;
                        box-shadow: -2px 0 5px rgba(0,0,0,0.1);
                    }
                    .matrix-table .sticky-right-2 {
                        position: sticky;
                        right: 38px; /* Offset for the very last column */
                        background: #f8f9fa !important;
                        z-index: 15;
                    }

                    .matrix-table .status-P { background-color: #d4edda !important; color: #155724; font-weight: bold; }
                    .matrix-table .status-A { background-color: #f8d7da !important; color: #721c24; }
                    .matrix-table .status-L { background-color: #cee3ff !important; color: #004085; font-weight: bold; }
                    .matrix-table .status-H { background-color: #fff3cd !important; color: #856404; font-weight: bold; }
                    .matrix-header-main { background: #6f42c1; color: white; position: sticky; top: 0; z-index: 30; }
                    .matrix-header-days { background: #e9ecef; font-weight: bold; position: sticky; top: 0; z-index: 21; }
                    .matrix-header-days .emp-name { z-index: 35; top: 0; }
                </style>
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h5 class="fw-bold mb-0">Matrix Attendance: ${startStr} to ${endStr}</h5>
                    <div class="badge bg-secondary">Total Days: ${days.length}</div>
                </div>
                <table class="matrix-table table-hover">
                    <thead>
                        <tr class="matrix-header-days">
                            <th class="emp-name" rowspan="2">Employee Name</th>
                            <th colspan="${days.length}">Attendance Days</th>
                            <th class="sticky-right-2" rowspan="2">Pres.</th>
                            <th class="sticky-right" rowspan="2">Abs.</th>
                        </tr>
                        <tr class="matrix-header-days">
                            ${days.map(d => `<th>${new Date(d).getDate()}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>`;

        let totalEmployees = emps.length;
        let totalPresentCount = 0;
        let totalAbsentCount = 0;

        emps.forEach(emp => {
            let presentCount = 0;
            let absentCount = 0;
            html += `<tr><td class="emp-name">${emp.name}</td>`;

            days.forEach(day => {
                const attended = logs ? logs.find(l => l.emp_id === emp.id && l.date === day) : null;
                const onLeave = leaves ? leaves.find(l => l.emp_id === emp.id && day >= l.start_date && day <= l.end_date) : null;
                const isHoliday = holidays ? holidays.find(h => h.date === day) : null;

                let code = 'A';
                let style = 'status-A';

                if (attended) {
                    code = 'P'; style = 'status-P'; presentCount++;
                } else if (onLeave) {
                    code = 'L'; style = 'status-L';
                } else if (isHoliday) {
                    code = 'H'; style = 'status-H';
                } else {
                    absentCount++;
                }

                html += `<td class="${style}">${code}</td>`;
            });

            totalPresentCount += presentCount;
            totalAbsentCount += absentCount;
            html += `<td class="fw-bold text-success sticky-right-2">${presentCount}</td><td class="fw-bold text-danger sticky-right">${absentCount}</td></tr>`;
        });

        html += `
                    </tbody>
                </table>
                <div class="row g-3 mt-4">
                    <div class="col-md-4">
                        <div class="card p-2 border-0 bg-light">
                            <small class="text-muted d-block">Total Employees</small>
                            <span class="h5 fw-bold mb-0 text-dark">${totalEmployees}</span>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card p-2 border-0 bg-light">
                            <small class="text-muted d-block">Total Present Days</small>
                            <span class="h5 fw-bold mb-0 text-success">${totalPresentCount}</span>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card p-2 border-0 bg-light">
                            <small class="text-muted d-block">Total Absent Days</small>
                            <span class="h5 fw-bold mb-0 text-danger">${totalAbsentCount}</span>
                        </div>
                    </div>
                </div>
                <div class="mt-4 p-3 bg-light rounded border">
                    <h6 class="fw-bold text-success mb-2"><i class="fas fa-list-check me-2"></i>Summary of Attendance</h6>
                    <div class="row g-3">
                        <div class="col-6 col-md-4">
                            <small class="text-muted d-block">Total No. of Employees</small>
                            <span class="fw-bold">${totalEmployees}</span>
                        </div>
                        <div class="col-6 col-md-4">
                            <small class="text-muted d-block">Total No. Employee Present (Total Days)</small>
                            <span class="fw-bold text-success">${totalPresentCount}</span>
                        </div>
                        <div class="col-6 col-md-4">
                            <small class="text-muted d-block">Total No. Employee Absent (Total Days)</small>
                            <span class="fw-bold text-danger">${totalAbsentCount}</span>
                        </div>
                    </div>
                </div>
            </div>`;
        container.innerHTML = html;
    },

    exportFullExcelReport: async () => {
        const type = document.getElementById('adv-report-type').value;
        const grain = document.getElementById('adv-report-grain').value;
        const start = document.getElementById('adv-start-date').value;
        const end = document.getElementById('adv-end-date').value;

        if (!start) return alert("Select start date");

        let startDate = new Date(start);
        let endDate = end ? new Date(end) : new Date(start);

        if (grain === 'weekly') {
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 6);
        } else if (grain === 'monthly') {
            startDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
            endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
        } else if (grain === 'quarterly') {
            const q = Math.floor(startDate.getMonth() / 3);
            startDate = new Date(startDate.getFullYear(), q * 3, 1);
            endDate = new Date(startDate.getFullYear(), (q + 1) * 3, 0);
        } else if (grain === 'yearly') {
            startDate = new Date(startDate.getFullYear(), 0, 1);
            endDate = new Date(startDate.getFullYear(), 11, 31);
        }

        const startStr = app.formatDate(startDate);
        const endStr = app.formatDate(endDate);
        const empId = document.getElementById('adv-report-emp').value;

        if (type === 'matrix') {
            return app.exportMatrixExcel(startStr, endStr, empId);
        }

        const { data: logs } = await db.from('attendance').select('*');
        const { data: emps } = await db.from('employees').select('*');

        const filteredLogs = logs.filter(l => l.date >= startStr && l.date <= endStr);

        const report = emps.map(emp => {
            const eLogs = filteredLogs.filter(l => l.emp_id === emp.id);
            return {
                'Employee ID': emp.id,
                'Name': emp.name,
                'Unit': emp.unit,
                'Shift': emp.shift || 'Shift-1',
                'Designation': emp.designation || 'Staff',
                'Days Present': eLogs.length,
                'Total Hours': eLogs.reduce((acc, l) => {
                    if (l.check_in && l.check_out) {
                        return acc + (new Date(`1970-01-01T${l.check_out}`) - new Date(`1970-01-01T${l.check_in}`)) / 36e5;
                    }
                    return acc;
                }, 0).toFixed(2)
            };
        });

        const ws = XLSX.utils.json_to_sheet(report);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Master Report");
        XLSX.writeFile(wb, `HROne_Report_${grain}_${startStr}.xlsx`);
    },

    exportMatrixExcel: async (startStr, endStr, empId = 'all') => {
        let { data: emps } = await db.from('employees').select('*');
        const { data: logs } = await db.from('attendance').select('*');
        const { data: leaves } = await db.from('leave_master').select('*');
        const { data: holidays } = await db.from('holiday_master').select('*');

        if (!emps) return alert("No staff found to export.");

        if (empId !== 'all') {
            emps = emps.filter(e => e.id == empId);
        }

        const days = [];
        let curr = new Date(startStr);
        const end = new Date(endStr);
        while (curr <= end) { days.push(app.formatDate(curr)); curr.setDate(curr.getDate() + 1); }

        const rows = [];
        const monthName = new Date(startStr).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

        // Row 1 (Index 0): Title & Month
        const row1 = ['HR-SMART ATTENDANCE REPORT', '', '', ''];
        row1.push(monthName);
        rows.push(row1);

        // Row 2 (Index 1): Headers Top
        const row2 = ['Sl. No', 'Name of the Employee', 'Attendance Status', ''];
        days.forEach(d => row2.push(new Date(d).getDate()));
        rows.push(row2);

        // Row 3 (Index 2): Headers Bottom
        const row3 = ['', '', 'No. of Days Present', 'No. of Days Absent'];
        rows.push(row3);

        let totalPresentAll = 0;
        let totalAbsentAll = 0;

        emps.forEach((emp, index) => {
            let pCount = 0;
            let aCount = 0;
            const empRow = [index + 1, emp.name, 0, 0];

            days.forEach(day => {
                const attended = logs ? logs.find(l => l.emp_id === emp.id && l.date === day) : null;
                const onLeave = leaves ? leaves.find(l => l.emp_id === emp.id && day >= l.start_date && day <= l.end_date) : null;
                const isHoliday = holidays ? holidays.find(h => h.date === day) : null;

                if (attended) { empRow.push('P'); pCount++; }
                else if (onLeave) { empRow.push('L'); }
                else if (isHoliday) { empRow.push('H'); }
                else { empRow.push('A'); aCount++; }
            });

            empRow[2] = pCount;
            empRow[3] = aCount;
            totalPresentAll += pCount;
            totalAbsentAll += aCount;
            rows.push(empRow);
        });

        // Totals Rows
        rows.push(['Total', '', totalPresentAll, totalAbsentAll]);
        rows.push(['% of Attendance', '', ((totalPresentAll / (totalPresentAll + totalAbsentAll || 1)) * 100).toFixed(2) + '%']);

        // Summary of Attendance Box (Placed at bottom-right area)
        const summaryStartCol = Math.max(4, 4 + days.length - 10);
        const summaryRows = [
            ['Summary of Attendance'],
            ['Total No. of Employees', emps.length],
            ['Total No. of Employee Present', totalPresentAll],
            ['Total No. of Employee Absent', totalAbsentAll]
        ];

        // Append summary rows starting from current row, but shifted right
        summaryRows.forEach((sRow, idx) => {
            const fullRow = Array(summaryStartCol).fill('');
            rows.push(fullRow.concat(sRow));
        });

        const ws = XLSX.utils.aoa_to_sheet(rows);

        // --- MERGES ---
        ws['!merges'] = [
            // Row 1 Title
            { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
            // Row 1 Month
            { s: { r: 0, c: 4 }, e: { r: 0, c: 4 + days.length - 1 } },
            // Sl No Vertical
            { s: { r: 1, c: 0 }, e: { r: 2, c: 0 } },
            // Name Vertical
            { s: { r: 1, c: 1 }, e: { r: 2, c: 1 } },
            // Attendance Status Horizontal
            { s: { r: 1, c: 2 }, e: { r: 1, c: 3 } },
            // Summary Header Horizontal
            { s: { r: rows.length - 4, c: summaryStartCol }, e: { r: rows.length - 4, c: summaryStartCol + 1 } }
        ];

        // Column Widths
        ws['!cols'] = [
            { wch: 6 },  // SL
            { wch: 30 }, // Name
            { wch: 20 }, // Present
            { wch: 20 }  // Absent
        ];
        days.forEach(() => ws['!cols'].push({ wch: 4 }));

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Attendance Matrix");
        XLSX.writeFile(wb, `Matrix_Report_${startStr}_to_${endStr}.xlsx`);
    },
    // ---------------------------------------------

    loadImage: (url) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.src = url;
            img.onload = () => resolve(img);
            img.onerror = (e) => reject(e);
        });
    },

    generateEmployeePDF: async () => {
        const empId = document.getElementById('report-emp-select').value;
        if (!empId) return alert("Please select an employee first.");

        // 1. Fetch Data
        const { data: emp } = await db.from('employees').select('*').eq('id', empId).single();
        const { data: logs } = await db.from('attendance').select('*').eq('emp_id', empId);

        if (!emp) return alert("Employee data not found.");

        // 2. Metrics Calculation
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

        const presentDays = logs.length;
        const todayDate = now.getDate();
        const daysPassed = Math.min(daysInMonth, todayDate);

        const absentDatesList = [];
        for (let d = 1; d <= daysPassed; d++) {
            const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const isPresent = logs.some(l => l.date === dateStr);
            if (!isPresent) {
                absentDatesList.push(String(d).padStart(2, '0'));
            }
        }
        const absentDaysCount = absentDatesList.length;
        const attendancePct = ((presentDays / daysPassed) * 100).toFixed(1);

        let totalHrs = 0;
        logs.forEach(l => {
            if (l.check_in && l.check_out) {
                totalHrs += (new Date(`1970-01-01T${l.check_out}`) - new Date(`1970-01-01T${l.check_in}`)) / 36e5;
            }
        });
        const efficiency = presentDays > 0 ? ((totalHrs / (presentDays * 8)) * 100).toFixed(1) : 0;

        // 3. Generate PDF
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const pageWidth = doc.internal.pageSize.getWidth();
        const monthName = now.toLocaleString('default', { month: 'long' });

        // --- HEADER ---
        try {
            const logoImg = await app.loadImage('static/images/logo.png');
            doc.addImage(logoImg, 'PNG', 14, 10, 20, 20);
        } catch (e) { console.warn("Logo missing"); }

        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(40);
        doc.text("Subhalaxmi Group of Companies", 40, 18);

        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text("New Industrial Estate, Jagatpur, Cuttack", 40, 24);

        doc.setFontSize(12);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 128, 0);
        doc.text(`PERFORMANCE REPORT: ${monthName.toUpperCase()}, ${currentYear}`, 14, 40);
        doc.setLineWidth(0.5);
        doc.setDrawColor(200);
        doc.line(14, 42, pageWidth - 14, 42);

        // --- SECTION A: PROFILE ---
        doc.setFillColor(240, 240, 240);
        doc.rect(14, 48, pageWidth - 28, 8, 'F');
        doc.setFontSize(10);
        doc.setTextColor(0);
        doc.text("SECTION A: GENERAL INFORMATION", 16, 53);

        const startY_A = 60;
        doc.setFontSize(10);

        doc.text(`Name:`, 16, startY_A); doc.setFont("helvetica", "bold"); doc.text(emp.name, 45, startY_A); doc.setFont("helvetica", "normal");
        doc.text(`Designation:`, 16, startY_A + 6); doc.text(emp.designation || 'N/A', 45, startY_A + 6);
        doc.text(`Employee ID:`, 16, startY_A + 12); doc.text(emp.id, 45, startY_A + 12);
        doc.text(`Unit:`, 16, startY_A + 18); doc.text(emp.unit || 'N/A', 45, startY_A + 18);
        doc.text(`Mobile:`, 16, startY_A + 24); doc.text(emp.mobile || 'N/A', 45, startY_A + 24);

        if (emp.photo && emp.photo.length > 100) {
            try {
                doc.addImage(emp.photo, 'JPEG', pageWidth - 50, startY_A - 2, 35, 35);
                doc.setDrawColor(0);
                doc.rect(pageWidth - 50, startY_A - 2, 35, 35);
            } catch (e) {
                doc.rect(pageWidth - 50, startY_A - 2, 35, 35);
                doc.text("No Photo", pageWidth - 45, startY_A + 15);
            }
        }

        // --- SECTION B: METRICS ---
        const startY_B = 105;
        doc.setFillColor(240, 240, 240);
        doc.rect(14, startY_B, pageWidth - 28, 8, 'F');
        doc.setFont("helvetica", "bold");
        doc.text("SECTION B: PERFORMANCE EVALUATION", 16, startY_B + 5);

        const tableY = startY_B + 10;
        doc.autoTable({
            startY: tableY,
            head: [['Metric', 'Value']],
            body: [
                ['Month / Year', `${monthName}, ${currentYear}`],
                ['Total Days (Month)', daysInMonth],
                ['Days Present', presentDays],
                ['Days Absent', absentDaysCount],
                ['Absent Dates', absentDatesList.length > 0 ? absentDatesList.join(", ") : "None"],
                ['Attendance %', `${attendancePct}%`],
                ['Performance Efficiency', `${efficiency}%`]
            ],
            theme: 'grid',
            headStyles: { fillColor: [44, 62, 80], textColor: 255 },
            columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
            margin: { left: 14, right: 14 }
        });

        // --- SECTION C: LOGS ---
        let startY_C = doc.lastAutoTable.finalY + 10;
        if (startY_C > 250) { doc.addPage(); startY_C = 20; }

        doc.setFillColor(240, 240, 240);
        doc.rect(14, startY_C, pageWidth - 28, 8, 'F');
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0);
        doc.text("SECTION C: DAILY WORK LOG", 16, startY_C + 5);

        const workData = logs.map(l => [l.date, l.check_in, l.check_out || '-', l.work_log || '-']);

        doc.autoTable({
            startY: startY_C + 10,
            head: [['Date', 'In Time', 'Out Time', 'Work Description']],
            body: workData.length > 0 ? workData : [['-', '-', '-', 'No logs found']],
            theme: 'striped',
            headStyles: { fillColor: [0, 128, 0] },
            styles: { fontSize: 9 },
            columnStyles: { 0: { cellWidth: 25 }, 1: { cellWidth: 25 }, 2: { cellWidth: 25 }, 3: { cellWidth: 'auto' } },
            margin: { left: 14, right: 14 }
        });

        // --- FOOTER ---
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            const footerY = doc.internal.pageSize.height - 20;
            doc.setLineWidth(0.5);
            doc.setDrawColor(200);
            doc.line(14, footerY, pageWidth - 14, footerY);
            doc.setFontSize(7);
            doc.setTextColor(100);
            doc.setFont("helvetica", "italic");
            const disclaimer = "CONFIDENTIALITY NOTICE: The information contained in this report is confidential and intended only for the internal use of Subhalaxmi Group of Companies. Any unauthorized review, use, disclosure, or distribution is prohibited. This is a system-generated report and does not require a physical signature.";
            const splitDisclaimer = doc.splitTextToSize(disclaimer, pageWidth - 28);
            doc.text(splitDisclaimer, 14, footerY + 5);
            doc.text(`Generated on: ${new Date().toLocaleString()}`, 14, footerY + 15);
            doc.text(`Page ${i} of ${pageCount}`, pageWidth - 30, footerY + 15);
        }

        doc.save(`${emp.name}_Performance_Report.pdf`);
    },

    generateEmployeeExcel: async () => {
        const empId = document.getElementById('report-emp-select').value;
        const { data: logs } = await db.from('attendance').select('*').eq('emp_id', empId);
        const ws = XLSX.utils.json_to_sheet(logs);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Logs");
        XLSX.writeFile(wb, "Employee_Log.xlsx");
    },

    exportFullExcelReport: async () => {
        const { data: emps } = await db.from('employees').select('*');
        const { data: logs } = await db.from('attendance').select('*');
        const report = emps.map(emp => {
            const eLogs = logs.filter(l => l.emp_id === emp.id);
            return { Name: emp.name, ID: emp.id, Unit: emp.unit, Shift: emp.shift || '-', Present: eLogs.length };
        });
        const ws = XLSX.utils.json_to_sheet(report);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Master");
        XLSX.writeFile(wb, "Master_Report.xlsx");
    },

    // ========================================================
    // 5. DASHBOARD & CHARTS
    // ========================================================
    loadOverallCharts: async () => {
        app.isOverallView = true;
        document.getElementById('selected-date-display').innerText = "Last 30 Days";

        const { data: logs } = await db.from('attendance').select('*').limit(2000);
        const { data: emps } = await db.from('employees').select('id, unit');

        const unitCounts = {};
        emps.forEach(e => { if (!unitCounts[e.unit]) unitCounts[e.unit] = 0; });
        logs.forEach(l => {
            const e = emps.find(emp => emp.id === l.emp_id);
            if (e && unitCounts[e.unit] !== undefined) unitCounts[e.unit]++;
        });
        const dpsDoughnut = Object.keys(unitCounts).map(u => ({ y: unitCounts[u], name: u }));

        const dpsLine = [];
        for (let i = 14; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const dStr = d.toISOString().split('T')[0];
            const dailyLogs = logs.filter(l => l.date === dStr);
            dpsLine.push({ label: dStr.slice(5), y: dailyLogs.length });
        }

        app.renderCanvasCharts(dpsDoughnut, dpsLine, "Plant Activity (30 Days)", "Attendance Trend");
    },

    renderDailyCharts: (attData, allEmps) => {
        const unitCounts = {};
        allEmps.forEach(e => { if (!unitCounts[e.unit]) unitCounts[e.unit] = 0; });
        attData.forEach(l => {
            const e = allEmps.find(emp => emp.id === l.emp_id);
            if (e && unitCounts[e.unit] !== undefined) unitCounts[e.unit]++;
        });
        const dpsDoughnut = Object.keys(unitCounts).map(u => ({ y: unitCounts[u], name: u }));

        const dpsLine = attData.map(l => {
            let h = 0;
            if (l.check_in && l.check_out) h = (new Date(`1970-01-01T${l.check_out}`) - new Date(`1970-01-01T${l.check_in}`)) / 36e5;
            return { label: l.name, y: parseFloat(h.toFixed(1)) };
        });

        app.renderCanvasCharts(dpsDoughnut, dpsLine, "Today's Plant Activity", "Work Hours Today");
    },

    renderCanvasCharts: (dps1, dps2, title1, title2) => {
        if (app.charts.plant) app.charts.plant.destroy();
        app.charts.plant = new CanvasJS.Chart("plantChartContainer", {
            animationEnabled: true, theme: "light2", title: { text: title1, fontSize: 16 },
            data: [{ type: "doughnut", showInLegend: true, dataPoints: dps1 }]
        });
        app.charts.plant.render();

        if (app.charts.efficiency) app.charts.efficiency.destroy();
        app.charts.efficiency = new CanvasJS.Chart("efficiencyChartContainer", {
            animationEnabled: true, theme: "light2", title: { text: title2, fontSize: 16 },
            axisY: { title: "Value" },
            data: [{ type: app.isOverallView ? "line" : "column", color: "#2E7D32", dataPoints: dps2 }]
        });
        app.charts.efficiency.render();
    },

    // --- LUNCH UTILIZATION (RED ALERT LOGIC) ---
    renderLunchTable: (attData) => {
        const tbody = document.getElementById('lunch-log-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        const lunchData = attData.filter(row => row.lunch_out);

        if (lunchData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-muted py-3">No lunch records yet.</td></tr>';
            return;
        }

        lunchData.forEach(row => {
            let duration = "--";
            let statusBadge = '<span class="badge badge-lunch-active">Ongoing</span>';
            let durationClass = "fw-bold text-primary";

            if (row.lunch_out && row.lunch_in) {
                const today = new Date().toISOString().split('T')[0];
                const start = new Date(`${today}T${row.lunch_out}`);
                const end = new Date(`${today}T${row.lunch_in}`);

                const diffMs = end - start;
                const diffMins = Math.floor(diffMs / 60000);
                const hrs = Math.floor(diffMins / 60);
                const mins = diffMins % 60;

                duration = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

                if (diffMins > 60) {
                    statusBadge = `<span class="badge bg-danger text-white">Over Limit (>1hr)</span>`;
                    durationClass = "fw-bold text-danger";
                } else {
                    statusBadge = `<span class="badge badge-lunch-done">Completed</span>`;
                    durationClass = "fw-bold text-success";
                }
            }

            tbody.innerHTML += `
                <tr>
                    <td class="text-start ps-4">
                        <div class="fw-bold text-dark">${row.name}</div>
                        <div class="small text-muted" style="font-size:0.75rem;">${row.emp_id}</div>
                    </td>
                    <td class="text-danger fw-bold">${row.lunch_out}</td>
                    <td class="text-success fw-bold">${row.lunch_in || '--:--'}</td>
                    <td class="${durationClass}">${duration}</td>
                    <td>${statusBadge}</td>
                </tr>`;
        });
    },

    // --- MAIN DASHBOARD REFRESH ---
    refreshDashboardData: async () => {
        if (!app.isOverallView) document.getElementById('selected-date-display').innerText = app.selectedDateStr;
        app.renderCalendar();

        const { data: attData } = await db.from('attendance').select('*').eq('date', app.selectedDateStr);
        const { data: allEmps } = await db.from('employees').select('*');
        const { data: leaveData } = await db.from('leave_master').select('*');

        const totalEmp = allEmps ? allEmps.length : 0;
        const presentCount = attData ? attData.length : 0;

        // Calculate leave count for today
        let leaveCount = 0;
        if (leaveData && allEmps) {
            leaveCount = allEmps.filter(e => {
                const onLeave = leaveData.find(l => l.emp_id === e.id && app.selectedDateStr >= l.start_date && app.selectedDateStr <= l.end_date);
                return onLeave;
            }).length;
        }

        const absentCount = totalEmp - presentCount - leaveCount;
        let totalHours = 0; let closedShifts = 0;

        const tbody = document.getElementById('activity-log-body');
        tbody.innerHTML = '';

        // Add employees who are on leave but not checked in
        if (allEmps && leaveData) {
            allEmps.forEach(emp => {
                const hasAtt = attData ? attData.find(a => a.emp_id === emp.id) : null;
                const onLeave = leaveData.find(l => l.emp_id === emp.id && app.selectedDateStr >= l.start_date && app.selectedDateStr <= l.end_date);

                if (onLeave && !hasAtt) {
                    tbody.innerHTML += `
                        <tr class="table-info">
                            <td><span class='badge bg-info'>Leave</span></td>
                            <td>
                                <div class="fw-bold">${emp.name}</div>
                                <div class="small text-muted">${emp.designation || '-'}</div>
                            </td>
                            <td>${emp.unit || '-'}</td>
                            <td><small>On Leave until ${onLeave.end_date}</small></td>
                            <td><span class="badge bg-secondary">${emp.shift || '-'}</span></td>
                            <td>-</td>
                            <td>-</td>
                        </tr>`;
                }
            });
        }

        if (attData) {
            attData.forEach(row => {
                const emp = allEmps.find(e => e.id === row.emp_id);
                const desig = emp && emp.designation ? emp.designation : '-';
                const shift = emp && emp.shift ? emp.shift : '-';

                // Check if this attendance overlaps with a leave record (e.g. they came in anyway)
                const onLeave = leaveData ? leaveData.find(l => l.emp_id === row.emp_id && app.selectedDateStr >= l.start_date && app.selectedDateStr <= l.end_date) : null;
                const statusBadge = onLeave ? '<span class="badge bg-info">Worked on Leave</span>' : `<span class='badge bg-${row.check_out ? 'success' : 'warning'}'>${row.check_out ? 'Done' : 'Active'}</span>`;

                let duration = "--";
                if (row.check_in && row.check_out) {
                    const s = new Date(`1970-01-01T${row.check_in}`);
                    const e = new Date(`1970-01-01T${row.check_out}`);
                    const hours = (e - s) / 36e5;
                    duration = hours.toFixed(2) + " hrs";
                    totalHours += hours;
                    closedShifts++;
                }

                const taskBtn = row.work_log ? 'btn-success' : 'btn-outline-primary';
                const taskTxt = row.work_log ? 'Edit' : 'Add';
                const safeLog = (row.work_log || '').replace(/'/g, "\\'");

                tbody.innerHTML += `
                    <tr>
                        <td>${statusBadge}</td>
                        <td>
                            <div class="fw-bold">${row.name}</div>
                            <div class="small text-muted">${desig}</div>
                        </td>
                        <td>${row.unit || '-'}</td>
                        <td><small>In: ${row.check_in}<br>Out: ${row.check_out || '-'}</small></td>
                        <td><span class="badge bg-secondary">${shift}</span></td>
                        <td><button class="btn btn-sm ${taskBtn}" onclick="app.openWorkLog('${row.id}', '${row.name}', '${safeLog}')">${taskTxt}</button></td>
                        <td><button class="btn btn-sm btn-outline-secondary" onclick="app.showPerformance('${row.emp_id}')"><i class="fas fa-chart-bar"></i></button></td>
                    </tr>`;
            });
        }

        const avgHours = closedShifts > 0 ? (totalHours / closedShifts).toFixed(1) : 0;
        document.getElementById('kpi-present').innerText = presentCount;
        document.getElementById('kpi-absent').innerText = absentCount;
        document.getElementById('kpi-hours').innerText = avgHours + 'h';

        app.renderLunchTable(attData);

        if (!app.isOverallView) app.renderDailyCharts(attData || [], allEmps || []);
    },

    // ========================================================
    // 6. ADVANCED FILTERING & CAMERA
    // ========================================================
    loadDesignations: async () => {
        const { data } = await db.from('employees').select('designation');
        if (data) {
            const unique = [...new Set(data.map(i => i.designation).filter(d => d && d.trim() !== ""))];
            const sel = document.getElementById('filter-designation');
            if (sel) {
                sel.innerHTML = `<option value="All">All Designations</option>` + unique.map(d => `<option value="${d}">${d}</option>`).join('');
            }
        }
    },

    applyFilters: async () => {
        const shift = document.getElementById('filter-shift').value;
        const desig = document.getElementById('filter-designation').value;
        const monthMode = document.getElementById('filter-month').value;

        const now = new Date();
        let startDate, endDate;

        if (monthMode === 'Current') {
            startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        } else {
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
            endDate = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
        }

        const { data: logs } = await db.from('attendance').select('*').gte('date', startDate).lte('date', endDate);
        const { data: emps } = await db.from('employees').select('*');

        if (!logs || !emps) {
            document.getElementById('activity-log-body').innerHTML = '<tr><td colspan="7">No data found.</td></tr>';
            return;
        }

        const filtered = logs.filter(log => {
            const employee = emps.find(e => e.id === log.emp_id);
            if (!employee) return false;

            const empShift = employee.shift || 'Shift-1';
            const empDesig = employee.designation || 'Staff';

            const matchesShift = (shift === 'All') || (empShift === shift);
            const matchesDesig = (desig === 'All') || (empDesig === desig);

            log.empDetails = { ...employee, shift: empShift, designation: empDesig };
            return matchesShift && matchesDesig;
        });

        const tbody = document.getElementById('activity-log-body');
        tbody.innerHTML = '';

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-muted py-3">No records match these filters.</td></tr>';
            return;
        }

        filtered.forEach(row => {
            const taskBtn = row.work_log ? 'btn-success' : 'btn-outline-primary';
            const taskTxt = row.work_log ? 'Edit' : 'Add';
            const safeLog = (row.work_log || '').replace(/'/g, "\\'");

            tbody.innerHTML += `
                <tr>
                    <td><span class='badge bg-${row.check_out ? 'success' : 'warning'}'>${row.check_out ? 'Done' : 'Active'}</span></td>
                    <td>
                        <div class="fw-bold">${row.name}</div>
                        <div class="small text-muted">${row.empDetails.designation}</div>
                    </td>
                    <td>${row.unit}</td>
                    <td><small>In: ${row.check_in}<br>Out: ${row.check_out || '-'}</small></td>
                    <td><span class="badge bg-secondary">${row.empDetails.shift}</span></td>
                    <td><button class="btn btn-sm ${taskBtn}" onclick="app.openWorkLog('${row.id}', '${row.name}', '${safeLog}')">${taskTxt}</button></td>
                    <td><button class="btn btn-sm btn-outline-secondary" onclick="app.showPerformance('${row.emp_id}')"><i class="fas fa-chart-bar"></i></button></td>
                </tr>`;
        });
    },

    exportFilteredReport: async () => {
        alert("Exporting current filter view...");
    },

    openEmployeeModal: async () => {
        const { data: units } = await db.from('units').select('*');
        const unitSelect = document.getElementById('reg-unit');
        if (unitSelect) {
            unitSelect.innerHTML = units.map(u => `<option value="${u.name}">${u.name}</option>`).join('');
        }

        const { data: shifts } = await db.from('shift_master').select('name');
        const shiftSelect = document.getElementById('reg-shift');
        if (shiftSelect && shifts) {
            shiftSelect.innerHTML = shifts.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
        }

        document.getElementById('reg-video').classList.remove('d-none');
        document.getElementById('reg-photo-preview').classList.add('d-none');
        document.getElementById('btn-capture').classList.remove('d-none');
        document.getElementById('btn-retake').classList.add('d-none');
        document.getElementById('reg-face-status').innerText = "Initializing Camera...";
        document.getElementById('reg-face-status').className = "small text-muted fw-bold";

        app.biometricDescriptor = null;
        app.currentPhoto = null;

        const modalEl = document.getElementById('addEmployeeModal');
        const modal = new bootstrap.Modal(modalEl);
        modal.show();

        modalEl.addEventListener('shown.bs.modal', () => { app.startRegCamera(); });
        modalEl.addEventListener('hidden.bs.modal', () => { app.stopRegCamera(); });
    },

    startRegCamera: async () => {
        const video = document.getElementById('reg-video');
        const status = document.getElementById('reg-face-status');

        if (document.getElementById('kiosk-video').srcObject) {
            const tracks = document.getElementById('kiosk-video').srcObject.getTracks();
            tracks.forEach(track => track.stop());
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
            video.srcObject = stream;
            status.innerText = "Camera Active";
            status.className = "small text-success fw-bold";
        } catch (err) {
            console.error("Camera Error:", err);
            status.innerText = "Camera Failed: HTTPS Required";
            status.className = "small text-danger fw-bold";
            alert("Camera Error:\nBrowsers block camera access on insecure (HTTP) connections.\n\nUse localhost or HTTPS.");
        }
    },

    stopRegCamera: () => {
        const video = document.getElementById('reg-video');
        if (video && video.srcObject) {
            const tracks = video.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            video.srcObject = null;
        }
    },

    captureFace: async () => {
        const vid = document.getElementById('reg-video');
        const preview = document.getElementById('reg-photo-preview');
        const status = document.getElementById('reg-face-status');
        const btn = document.getElementById('btn-capture');

        if (!app.faceModelsLoaded) return alert("Loading AI Models... Please wait.");
        if (!vid.srcObject) return alert("Camera not active.");

        // 1. Instant Visual Feedback
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        status.innerText = "Analyzing Face... Please hold still.";
        status.className = "text-warning fw-bold small mt-1";

        // 2. Immediate Snapshot to Canvas
        const canvas = document.createElement('canvas');
        canvas.width = vid.videoWidth || 320;
        canvas.height = vid.videoHeight || 240;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        const snapshotData = canvas.toDataURL('image/jpeg', 0.9);

        // Show preview immediately to "freeze" the frame
        preview.src = snapshotData;
        vid.classList.add('d-none');
        preview.classList.remove('d-none');

        // 3. Background Face Detection
        try {
            const det = await faceapi.detectSingleFace(canvas).withFaceLandmarks().withFaceDescriptor();

            if (det) {
                app.biometricDescriptor = Array.from(det.descriptor);
                app.currentPhoto = snapshotData;

                btn.classList.add('d-none');
                document.getElementById('btn-retake').classList.remove('d-none');

                status.innerText = "Face Verified Successfully!";
                status.className = "text-success fw-bold small mt-1";

                app.stopRegCamera();
            } else {
                // Detection failed - revert UI
                status.innerText = "Detection Failed! No face found in snapshot.";
                status.className = "text-danger fw-bold small mt-1";

                // Show retake button since we've already "captured" a failed frame
                btn.classList.add('d-none');
                document.getElementById('btn-retake').classList.remove('d-none');
            }
        } catch (err) {
            console.error("Capture Error:", err);
            status.innerText = "Error during analysis.";
            status.className = "text-danger fw-bold small mt-1";
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-camera"></i> Capture Face';
        }
    },

    retakePhoto: async () => {
        const vid = document.getElementById('reg-video');
        const preview = document.getElementById('reg-photo-preview');

        preview.classList.add('d-none');
        vid.classList.remove('d-none');
        document.getElementById('btn-retake').classList.add('d-none');
        document.getElementById('btn-capture').classList.remove('d-none');

        document.getElementById('reg-face-status').innerText = "Camera Active";
        document.getElementById('reg-face-status').className = "small text-success fw-bold";

        app.biometricDescriptor = null;
        app.currentPhoto = null;

        await app.startRegCamera();
    },

    saveEmployee: async () => {
        const id = document.getElementById('reg-id').value;
        const name = document.getElementById('reg-name').value;
        const desig = document.getElementById('reg-designation').value;
        const mobile = document.getElementById('reg-mobile').value;
        const unit = document.getElementById('reg-unit').value;
        const aadhar = document.getElementById('reg-aadhar').value;
        const address = document.getElementById('reg-address').value;
        const shift = document.getElementById('reg-shift').value;

        if (!id || !name || !unit || !mobile) return alert("Fill required fields: ID, Name, Mobile, Unit.");
        if (!app.biometricDescriptor) return alert("Biometric required! Click Capture.");
        if (!app.currentPhoto) return alert("Photo capture failed.");

        if (app.labeledDescriptors.length > 0) {
            const matcher = new faceapi.FaceMatcher(app.labeledDescriptors, 0.6);
            const match = matcher.findBestMatch(new Float32Array(app.biometricDescriptor));
            if (match.label !== 'unknown') return alert(`Duplicate: Already registered as ${match.label}`);
        }

        const { error } = await db.from('employees').insert([{
            id: id, name: name, unit: unit, designation: desig,
            mobile: mobile, aadhar: aadhar, address: address, shift: shift,
            face_descriptor: app.biometricDescriptor, photo: app.currentPhoto
        }]);

        if (!error) {
            alert("Staff Registered Successfully!");
            app.loadFaceData();
            bootstrap.Modal.getInstance(document.getElementById('addEmployeeModal')).hide();
            document.getElementById('reg-name').value = "";
            document.getElementById('reg-id').value = "";
        } else alert(error.message);
    },

    openStaffDirectory: async () => {
        const { data } = await db.from('employees').select('*');
        const tbody = document.getElementById('staff-list-body');
        tbody.innerHTML = '';
        if (data) {
            data.forEach(emp => {
                tbody.innerHTML += `
                    <tr>
                        <td>${emp.id}</td>
                        <td>${emp.name}</td>
                        <td>${emp.unit} <br><small class="text-muted">${emp.shift || 'Shift-1'}</small></td>
                        <td>
                            <div class="btn-group btn-group-sm">
                                <button class="btn btn-outline-secondary" onclick="app.openShiftModal('${emp.id}', '${emp.name}', '${emp.shift || 'Shift-1'}')"><i class="fas fa-clock"></i></button>
                                <button class="btn btn-outline-danger" onclick="app.deleteEmployee('${emp.id}','${emp.name}')"><i class="fas fa-trash"></i></button>
                            </div>
                        </td>
                    </tr>`;
            });
        }
        new bootstrap.Modal(document.getElementById('staffDirectoryModal')).show();
    },

    filterStaff: (q) => { const rows = document.getElementById('staff-list-body').getElementsByTagName('tr'); for (let r of rows) r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase()) ? "" : "none"; },
    deleteEmployee: async (id, name) => { if (confirm(`Delete ${name}?`)) { await db.from('employees').delete().eq('id', id); alert("Deleted"); app.openStaffDirectory(); app.refreshDashboardData(); app.loadFaceData(); } },

    openWorkLog: (id, name, log) => { document.getElementById('logAttId').value = id; document.getElementById('logEmpName').value = name; document.getElementById('logText').value = log; new bootstrap.Modal(document.getElementById('workLogModal')).show(); },
    saveWorkLog: async () => { await db.from('attendance').update({ work_log: document.getElementById('logText').value }).eq('id', document.getElementById('logAttId').value); bootstrap.Modal.getInstance(document.getElementById('workLogModal')).hide(); app.refreshDashboardData(); },

    openUnitModal: async () => { const { data } = await db.from('units').select('*'); document.getElementById('unit-list').innerHTML = data.map(u => `<li class="list-group-item d-flex justify-content-between">${u.name} <button class="btn btn-sm btn-danger" onclick="app.deleteUnit(${u.id})">&times;</button></li>`).join(''); new bootstrap.Modal(document.getElementById('unitModal')).show(); },
    addUnit: async () => {
        const name = document.getElementById('new-unit-name').value;
        if (!name) return alert("Enter unit name");
        await db.from('units').insert([{ id: Date.now().toString(), name: name }]);
        document.getElementById('new-unit-name').value = "";
        app.openUnitModal();
    },
    deleteUnit: async (id) => { if (confirm("Delete?")) await db.from('units').delete().eq('id', id); app.openUnitModal(); },

    showPerformance: async (empId) => {
        const { data: logs } = await db.from('attendance').select('*').eq('emp_id', empId).limit(30);
        const labels = logs.map(l => l.date);
        const data = logs.map(l => { if (!l.check_out) return 0; return ((new Date(`1970-01-01T${l.check_out}`) - new Date(`1970-01-01T${l.check_in}`)) / 36e5).toFixed(1); });
        const ctx = document.getElementById('perfChart').getContext('2d');
        if (app.perfChartInstance) app.perfChartInstance.destroy();
        app.perfChartInstance = new Chart(ctx, { type: 'bar', data: { labels, datasets: [{ label: 'Hours', data }] } });
        new bootstrap.Modal(document.getElementById('performanceModal')).show();
    },

    updateLicense: async () => {
        const date = document.getElementById('license-date').value;
        if (!date) return alert("Select date");
        await db.from('system_settings').upsert({ setting_key: 'license_expiry', setting_value: date });
        alert("License Updated");
    },
    wipeAttendanceData: async () => {
        if (prompt("PIN:") === "2026") { await db.from('attendance').delete().neq('id', 0); alert("Wiped Attendance"); }
    },
    wipeEmployeeData: async () => {
        if (prompt("PIN:") === "2026") { await db.from('employees').delete().neq('id', '0'); alert("Wiped Employees"); }
    },
    toggleSystemLock: async (e) => { await db.from('system_settings').upsert({ setting_key: 'system_lock', setting_value: e.target.checked ? 'active' : 'locked' }); app.systemLocked = !e.target.checked; },

    // --- NEW: HR EXTENSIONS (Leave, Holidays, Shift) ---
    openLeaveManager: async () => {
        document.getElementById('admin-view').classList.add('d-none');
        document.getElementById('leave-manager-section').classList.remove('d-none');
        app.loadLeaveData();
    },

    closeLeaveManager: () => {
        document.getElementById('leave-manager-section').classList.add('d-none');
        document.getElementById('admin-view').classList.remove('d-none');
    },

    loadLeaveData: async () => {
        const { data } = await db.from('leave_master').select('*');
        const tbody = document.getElementById('leave-list-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (data) {
            data.forEach(l => {
                const status = new Date() > new Date(l.end_date) ? "Expired" : "Active";
                tbody.innerHTML += `
                    <tr>
                        <td>${l.emp_id}</td>
                        <td>${l.start_date} to ${l.end_date}</td>
                        <td><span class="badge bg-${l.type === 'Authorized' ? 'primary' : 'danger'}">${l.type}</span></td>
                        <td>${status}</td>
                        <td><button class="btn btn-sm btn-outline-danger" onclick="app.deleteLeave('${l.id}')"><i class="fas fa-trash"></i></button></td>
                    </tr>`;
            });
        }
    },

    openGrantLeaveModal: async () => {
        const { data } = await db.from('employees').select('id, name');
        const sel = document.getElementById('leave-emp-select');
        if (sel) sel.innerHTML = data.map(e => `<option value="${e.id}">${e.name} (${e.id})</option>`).join('');
        new bootstrap.Modal(document.getElementById('grantLeaveModal')).show();
    },

    saveLeave: async () => {
        const payload = {
            id: Date.now().toString(),
            emp_id: document.getElementById('leave-emp-select').value,
            start_date: document.getElementById('leave-start-date').value,
            end_date: document.getElementById('leave-end-date').value,
            type: document.getElementById('leave-type').value,
            status: 'Approved'
        };
        await db.from('leave_master').insert([payload]);
        bootstrap.Modal.getInstance(document.getElementById('grantLeaveModal')).hide();
        app.loadLeaveData();
    },

    deleteLeave: async (id) => {
        if (confirm("Delete this leave record?")) {
            await db.from('leave_master').eq('id', id).delete();
            app.loadLeaveData();
        }
    },

    openHolidayManager: async () => {
        const { data } = await db.from('holiday_master').select('*');
        const list = document.getElementById('holiday-list');
        if (list) {
            list.innerHTML = data.map(h => `
                <li class="list-group-item d-flex justify-content-between align-items-center">
                    ${h.date}: ${h.description}
                    <button class="btn btn-sm text-danger" onclick="app.deleteHoliday('${h.id}')">&times;</button>
                </li>`).join('');
        }
        new bootstrap.Modal(document.getElementById('holidayModal')).show();
    },

    addHoliday: async () => {
        const payload = {
            id: Date.now().toString(),
            date: document.getElementById('new-holiday-date').value,
            description: document.getElementById('new-holiday-desc').value
        };
        await db.from('holiday_master').insert([payload]);
        app.openHolidayManager();
    },

    deleteHoliday: async (id) => {
        await db.from('holiday_master').eq('id', id).delete();
        app.openHolidayManager();
    },

    openShiftModal: async (id, name, shift) => {
        document.getElementById('shift-emp-id').value = id;
        document.getElementById('shift-emp-name').innerText = name;

        // Dynamic shifts
        const { data } = await db.from('shift_master').select('name');
        const sel = document.getElementById('shift-select');
        if (data && data.length > 0) {
            sel.innerHTML = data.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
            sel.value = shift;
        }

        new bootstrap.Modal(document.getElementById('shiftModal')).show();
    },

    updateShift: async () => {
        const id = document.getElementById('shift-emp-id').value;
        const shift = document.getElementById('shift-select').value;
        await db.from('employees').update({ shift }).eq('id', id);
        bootstrap.Modal.getInstance(document.getElementById('shiftModal')).hide();
        app.openStaffDirectory();
        alert("Shift updated successfully!");
    },

    // --- NEW: SHIFT MASTER LOGIC ---
    openShiftMaster: async () => {
        new bootstrap.Modal(document.getElementById('shiftMasterModal')).show();
        app.loadShiftMasterList();
    },

    loadShiftMasterList: async () => {
        const { data } = await db.from('shift_master').select('*');
        const tbody = document.getElementById('shift-master-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (data) {
            data.forEach(s => {
                tbody.innerHTML += `
                    <tr>
                        <td class="fw-bold text-primary">${s.name}</td>
                        <td>${s.start_time} - ${s.end_time}</td>
                        <td><span class="badge bg-info">${s.total_hours} hrs</span></td>
                        <td>
                            <div class="btn-group btn-group-sm">
                                <button class="btn btn-outline-primary" onclick="app.editShiftMaster('${s.id}', '${s.name}', '${s.start_time}', '${s.end_time}')"><i class="fas fa-edit"></i></button>
                                <button class="btn btn-outline-danger" onclick="app.deleteShiftMaster('${s.id}')"><i class="fas fa-trash"></i></button>
                            </div>
                        </td>
                    </tr>`;
            });
        }
    },

    calcShiftHours: () => {
        const start = document.getElementById('ms-start').value;
        const end = document.getElementById('ms-end').value;
        const hourBox = document.getElementById('ms-hours');
        if (start && end) {
            let [h1, m1] = start.split(':').map(Number);
            let [h2, m2] = end.split(':').map(Number);
            let d1 = new Date(2000, 0, 1, h1, m1);
            let d2 = new Date(2000, 0, 1, h2, m2);
            if (d2 < d1) d2.setDate(d2.getDate() + 1); // Crosses midnight
            const diff = (d2 - d1) / (1000 * 60 * 60);
            hourBox.value = diff.toFixed(2);
        }
    },

    saveShiftMaster: async () => {
        const name = document.getElementById('ms-name').value;
        const start = document.getElementById('ms-start').value;
        const end = document.getElementById('ms-end').value;
        const hours = document.getElementById('ms-hours').value;
        const id = app.editingShiftId || Date.now().toString();

        if (!name || !start || !end) return alert("Fill all fields");

        const payload = { id, name, start_time: start, end_time: end, total_hours: hours };

        if (app.editingShiftId) {
            await db.from('shift_master').update(payload).eq('id', id);
            app.editingShiftId = null;
        } else {
            await db.from('shift_master').insert([payload]);
        }

        // Reset form
        document.getElementById('ms-name').value = '';
        document.getElementById('ms-start').value = '';
        document.getElementById('ms-end').value = '';
        document.getElementById('ms-hours').value = '';

        app.loadShiftMasterList();
        alert("Shift Master Updated!");
    },

    editShiftMaster: (id, name, start, end) => {
        app.editingShiftId = id;
        document.getElementById('ms-name').value = name;
        document.getElementById('ms-start').value = start;
        document.getElementById('ms-end').value = end;
        app.calcShiftHours();
        document.getElementById('ms-name').focus();
    },

    deleteShiftMaster: async (id) => {
        if (confirm("Delete this shift master?")) {
            await db.from('shift_master').eq('id', id).delete();
            app.loadShiftMasterList();
        }
    },

    markAttendance: async (name) => {
        const now = new Date();
        if (!app.isOnline) {
            const scans = JSON.parse(localStorage.getItem('offlineScans') || '[]');
            scans.push({ name: name, timestamp: now.toISOString() });
            localStorage.setItem('offlineScans', JSON.stringify(scans));
            app.showMsg("Offline Saved", "warning");
            app.speak("Network unavailable. Saved locally.");
            return;
        }
        await app.processAttendanceLogic(name, now);
    },

    processAttendanceLogic: async (name, dateObj) => {
        const hour = dateObj.getHours();
        const { data: emp } = await db.from('employees').select('*').eq('name', name).single();
        if (!emp) return;

        // Fetch Shift Master for this employee
        const { data: shiftMaster } = await db.from('shift_master').select('*');
        const empShift = shiftMaster ? shiftMaster.find(s => s.name === (emp.shift || 'Shift-1')) : null;

        const todayStr = dateObj.toISOString().split('T')[0];

        // 1. Check Holiday Master
        const { data: holidays } = await db.from('holiday_master').select('*');
        const isHoliday = holidays ? holidays.find(h => h.date === todayStr) : null;
        if (isHoliday) {
            app.showMsg(`Today is a Holiday: ${isHoliday.description}`, "warning");
            app.speak(`Today is a company holiday for ${isHoliday.description}.`);
            return;
        }

        // 2. Check Leave Master
        const { data: leaves } = await db.from('leave_master').select('*');
        const activeLeave = leaves ? leaves.find(l => l.emp_id == emp.id && todayStr >= l.start_date && todayStr <= l.end_date) : null;

        if (activeLeave) {
            if (activeLeave.type === 'Unauthorized') {
                app.showMsg(`ALERT: Unauthorized Attempt - ${name}`, "danger");
                app.speak(`Alert. Unauthorized Login Attempt detected by ${name}.`);

                // Log unauthorized attempt for Admin
                await db.from('system_alerts').insert([{
                    id: Date.now().toString(),
                    emp_id: emp.id,
                    name: name,
                    type: 'Unauthorized Leave Attempt',
                    timestamp: dateObj.toISOString(),
                    status: 'Unread'
                }]);
                return;
            } else {
                app.showMsg(`${name} is on Authorized Leave`, "info");
                app.speak(`${name} is currently on leave.`);
                return;
            }
        }

        const last = app.lastScanMap.get(emp.id);
        if (last && (dateObj.getTime() - last < app.SCAN_COOLDOWN)) return;

        let shiftDate = new Date(dateObj);
        // If it's a night shift (e.g. starting late), we might need logic adjustment
        if (hour < 4) shiftDate.setDate(shiftDate.getDate() - 1);
        const shiftDateStr = shiftDate.toISOString().split('T')[0];
        const timeNowStr = dateObj.toLocaleTimeString('en-GB');

        const { data: att } = await db.from('attendance').select('*').eq('emp_id', emp.id).eq('date', shiftDateStr).single();

        let msg = "", type = "success", voiceMsg = "";

        // Dynamic Logic based on Shift Master
        let checkInBound = 12; // Default
        let lunchBound = 16;

        if (empShift && empShift.start_time) {
            const [sH] = empShift.start_time.split(':').map(Number);
            checkInBound = sH + 4; // Allow check-in up to 4 hours after start? or use specific gaps
            lunchBound = sH + 8;
        }

        if (hour >= 4 && hour < checkInBound) {
            if (!att) {
                await db.from('attendance').insert([{ emp_id: emp.id, name: name, unit: emp.unit, date: shiftDateStr, check_in: timeNowStr }]);
                msg = `Checked In`; voiceMsg = `Good Morning ${name}.`;
            } else {
                msg = `Already Checked In`; type = "secondary"; voiceMsg = `Already checked in.`;
            }
        }
        else if (hour >= 12 && hour < 16) {
            if (att) {
                if (!att.lunch_out) {
                    await db.from('attendance').update({ lunch_out: timeNowStr }).eq('id', att.id);
                    msg = `Lunch Start`; type = "warning"; voiceMsg = `Enjoy lunch.`;
                } else if (!att.lunch_in) {
                    await db.from('attendance').update({ lunch_in: timeNowStr }).eq('id', att.id);
                    msg = `Lunch End`; voiceMsg = `Welcome back.`;
                } else {
                    msg = `Lunch Done`; type = "secondary";
                }
            } else {
                await db.from('attendance').insert([{ emp_id: emp.id, name: name, unit: emp.unit, date: shiftDateStr, check_in: timeNowStr }]);
                msg = `Late Check-in`; type = "warning"; voiceMsg = `Late check-in recorded.`;
            }
        }
        else {
            if (att) {
                await db.from('attendance').update({ check_out: timeNowStr }).eq('id', att.id);
                msg = `Checked Out`; type = "info"; voiceMsg = `Shift Ended.`;
            } else {
                await db.from('attendance').insert([{ emp_id: emp.id, name: name, unit: emp.unit, date: shiftDateStr, check_in: timeNowStr }]);
                msg = `Night Shift In`; type = "success"; voiceMsg = `Night shift check-in.`;
            }
        }

        app.lastScanMap.set(emp.id, dateObj.getTime());
        app.showMsg(`${msg}: ${name}`, type);
        app.speak(voiceMsg);
    },

    showMsg: (txt, type) => {
        const box = document.getElementById('scan-message');
        if (box) {
            box.className = `mt-4 alert alert-${type} fw-bold w-75`;
            box.innerText = txt;
            setTimeout(() => { box.innerText = "Align face within frame"; box.className = "mt-4 alert alert-dark w-75"; }, 4000);
        }
    },

    switchView: async (view) => {
        if (view === 'kiosk') {
            document.getElementById('login-section').classList.add('d-none');
            document.getElementById('kiosk-view').classList.remove('d-none');
            await app.checkSystemStatus();
            if (app.systemLocked) { document.getElementById('maintenance-overlay').classList.remove('d-none'); return; }
            await app.loadFaceData();
            app.startKioskScanner();
        }
    },

    startKioskScanner: async () => {
        const video = document.getElementById('kiosk-video');
        const canvas = document.getElementById('kiosk-canvas');
        const statusBox = document.getElementById('scan-message');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
            video.srcObject = stream;
        } catch (err) {
            console.error("Camera Error:", err);
            statusBox.innerText = "Camera Access Denied";
            return;
        }

        video.addEventListener('play', () => {
            const displaySize = { width: video.clientWidth || 640, height: video.clientHeight || 480 };
            faceapi.matchDimensions(canvas, displaySize);

            setInterval(async () => {
                if (app.systemLocked || app.labeledDescriptors.length === 0) return;
                if (video.videoWidth === 0 || video.videoHeight === 0) return;

                const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
                const resized = faceapi.resizeResults(detections, displaySize);
                canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

                if (resized.length > 0) {
                    const result = new faceapi.FaceMatcher(app.labeledDescriptors, 0.6).findBestMatch(resized[0].descriptor);

                    if (result.label !== 'unknown') {
                        const name = result.label;
                        const now = Date.now();
                        const lastScan = app.scanLock.get(name);
                        if (lastScan && (now - lastScan < 60000)) {
                            statusBox.innerText = `Verified: ${name}`;
                            statusBox.className = "mt-4 alert alert-success fw-bold w-75";
                            return;
                        }
                        app.scanLock.set(name, now);
                        app.markAttendance(name);

                        statusBox.innerText = `Verified: ${name}`;
                        statusBox.className = "mt-4 alert alert-success fw-bold w-75";
                    } else {
                        statusBox.innerText = "Unknown Face";
                        statusBox.className = "mt-4 alert alert-warning w-75";
                    }
                } else {
                    statusBox.innerText = "Align face within frame...";
                    statusBox.className = "mt-4 alert alert-dark w-75";
                }
            }, 500);
        });
    },

    setupNetworkListeners: () => {
        window.addEventListener('online', () => { app.isOnline = true; app.updateNetworkUI(true); app.syncOfflineData(); });
        window.addEventListener('offline', () => { app.isOnline = false; app.updateNetworkUI(false); });
    },
    updateNetworkUI: (online) => {
        const b = document.getElementById('network-status');
        if (b) { b.innerHTML = online ? '<i class="fas fa-wifi"></i> Online' : '<i class="fas fa-wifi-slash"></i> Offline'; b.className = online ? 'badge bg-success' : 'badge bg-danger'; }
    },
    syncOfflineData: async () => {
        const s = JSON.parse(localStorage.getItem('offlineScans') || '[]');
        if (s.length > 0) {
            for (const x of s) await app.processAttendanceLogic(x.name, new Date(x.timestamp));
            localStorage.removeItem('offlineScans');
            alert('Offline data synced!');
        }
    },

    updateDate: () => { const d = new Date(); document.getElementById('current-date').innerText = d.toDateString(); document.getElementById('mob-current-date').innerText = d.toDateString(); document.getElementById('dynamic-year').innerText = d.getFullYear(); },

    fetchWeather: async () => {
        try {
            const [w, a] = await Promise.all([fetch("https://api.open-meteo.com/v1/forecast?latitude=20.49&longitude=85.91&current=temperature_2m"), fetch("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=20.49&longitude=85.91&current=us_aqi")]);
            const wd = await w.json(); const ad = await a.json();
            const t = wd.current.temperature_2m + "°C"; const q = ad.current.us_aqi;
            if (document.getElementById('weather-temp')) document.getElementById('weather-temp').innerText = t;
            if (document.getElementById('mob-weather')) document.getElementById('mob-weather').innerText = t;
            if (document.getElementById('mob-aqi')) document.getElementById('mob-aqi').innerText = q;
            if (document.getElementById('mob-aqi-nav')) document.getElementById('mob-aqi-nav').innerText = q;
        } catch (e) { }
    },

    loadFaceData: async () => {
        const { data } = await db.from('employees').select('name, face_descriptor');
        if (data) {
            app.labeledDescriptors = data.filter(e => e.face_descriptor).map(e => {
                let descriptor = e.face_descriptor;
                if (typeof descriptor === 'string') {
                    try {
                        descriptor = JSON.parse(descriptor);
                    } catch (err) {
                        descriptor = descriptor.split(',').map(Number);
                    }
                }
                // Ensure it is an array or typed array of length 128
                if (descriptor && descriptor.length === 128) {
                    return new faceapi.LabeledFaceDescriptors(e.name, [new Float32Array(descriptor)]);
                }
                console.warn(`Skipping invalid descriptor for ${e.name}: expected 128 elements, got ${descriptor ? descriptor.length : 0}`);
                return null;
            }).filter(d => d !== null);
        }
    },

    selectDate: (d) => { app.selectedDateStr = d; app.isOverallView = false; app.refreshDashboardData(); },
    resetToToday: () => { app.selectedDateStr = new Date().toISOString().split('T')[0]; app.isOverallView = false; app.refreshDashboardData(); },
    changeMonth: (d) => { app.currentDate.setMonth(app.currentDate.getMonth() + d); app.renderCalendar(); },
    renderCalendar: () => { const g = document.getElementById('calendar-grid'); if (!g) return; g.innerHTML = ''; const y = app.currentDate.getFullYear(); const m = app.currentDate.getMonth(); document.getElementById('calendar-month-year').innerText = new Date(y, m).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(d => g.innerHTML += `<div class="calendar-day-header">${d}</div>`); const f = new Date(y, m, 1).getDay(); const days = new Date(y, m + 1, 0).getDate(); for (let i = 0; i < f; i++)g.innerHTML += `<div></div>`; for (let d = 1; d <= days; d++) { const dt = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; g.innerHTML += `<div class="calendar-day ${dt === app.selectedDateStr ? 'active' : ''}" onclick="app.selectDate('${dt}')">${d}</div>`; } },

    formatDate: (date) => {
        const d = new Date(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    populateReportEmployees: async () => {
        const { data: emps } = await db.from('employees').select('id, name');
        const select = document.getElementById('adv-report-emp');
        if (select && emps) {
            select.innerHTML = '<option value="all">All Employees</option>';
            emps.forEach(e => {
                const opt = document.createElement('option');
                opt.value = e.id;
                opt.textContent = `${e.name} (${e.id})`;
                select.appendChild(opt);
            });
        }
    }
};

document.addEventListener('DOMContentLoaded', app.init);
