// ========================================================
// 1. CONFIGURATION & SUPABASE SETUP
// ========================================================
const SUPABASE_URL = 'https://mfltcynaktqhppbiptyi.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mbHRjeW5ha3RxaHBwYmlwdHlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NjQxODAsImV4cCI6MjA4MzQ0MDE4MH0.sCy4XLg6JD-AtjpwlauYmuxNkxmPFo4vx7_R_pYyn-w';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
        app.setupNetworkListeners();
        await app.checkSystemStatus();
        app.attachListeners();

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
        const { data } = await supabaseClient.from('system_settings').select('*').eq('setting_key', 'system_lock').single();
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
        const { data: lic } = await supabaseClient.from('system_settings').select('*').eq('setting_key', 'license_expiry').single();
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
    // 4. DASHBOARD & CHARTS
    // ========================================================
    loadOverallCharts: async () => {
        app.isOverallView = true;
        document.getElementById('selected-date-display').innerText = "Last 30 Days";

        const { data: logs } = await supabaseClient.from('attendance').select('*').limit(2000);
        const { data: emps } = await supabaseClient.from('employees').select('id, unit');

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
            if(l.check_in && l.check_out) h = (new Date(`1970-01-01T${l.check_out}`) - new Date(`1970-01-01T${l.check_in}`)) / 36e5;
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

        // 1. Fetch Logs for Selected Date
        const { data: attData } = await supabaseClient.from('attendance').select('*').eq('date', app.selectedDateStr);
        // 2. Fetch Employees for join/details
        const { data: allEmps } = await supabaseClient.from('employees').select('*');

        const totalEmp = allEmps ? allEmps.length : 0;
        const presentCount = attData ? attData.length : 0;
        const absentCount = totalEmp - presentCount;
        let totalHours = 0; let closedShifts = 0;

        // Populate Table
        const tbody = document.getElementById('activity-log-body');
        tbody.innerHTML = '';

        if (attData) {
            attData.forEach(row => {
                // Find employee details for Designation/Shift display
                const emp = allEmps.find(e => e.id === row.emp_id);
                const desig = emp ? emp.designation : '-';
                const shift = emp ? emp.shift : '-';

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
                        <td><span class='badge bg-${row.check_out ? 'success' : 'warning'}'>${row.check_out ? 'Done' : 'Active'}</span></td>
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
    // 5. ADVANCED FILTERING & REPORTING
    // ========================================================
    loadDesignations: async () => {
        const { data } = await supabaseClient.from('employees').select('designation');
        if(data) {
            const unique = [...new Set(data.map(i => i.designation).filter(Boolean))];
            const sel = document.getElementById('filter-designation');
            if(sel) sel.innerHTML = `<option value="All">All Designations</option>` + unique.map(d => `<option value="${d}">${d}</option>`).join('');
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

        const { data: logs } = await supabaseClient.from('attendance').select('*').gte('date', startDate).lte('date', endDate);
        const { data: emps } = await supabaseClient.from('employees').select('*');

        if (!logs || !emps) return;

        const filtered = logs.filter(log => {
            const employee = emps.find(e => e.id === log.emp_id);
            if (!employee) return false;
            const matchesShift = (shift === 'All') || (employee.shift === shift);
            const matchesDesig = (desig === 'All') || (employee.designation === desig);
            log.empDetails = employee; 
            return matchesShift && matchesDesig;
        });

        // Re-render Table with Filtered Data (Same logic as refreshDashboardData but using 'filtered')
        const tbody = document.getElementById('activity-log-body');
        tbody.innerHTML = '';
        
        filtered.forEach(row => {
            tbody.innerHTML += `
                <tr>
                    <td><span class='badge bg-${row.check_out ? 'success' : 'warning'}'>${row.check_out ? 'Done' : 'Active'}</span></td>
                    <td><div class="fw-bold">${row.name}</div><div class="small text-muted">${row.empDetails.designation || '-'}</div></td>
                    <td>${row.unit}</td>
                    <td><small>In: ${row.check_in}<br>Out: ${row.check_out||'-'}</small></td>
                    <td><span class="badge bg-secondary">${row.empDetails.shift || '-'}</span></td>
                    <td>...</td>
                    <td>...</td>
                </tr>`;
        });
    },

    exportFilteredReport: async () => {
        alert("Report generation based on current filters initiated...");
        // Logic similar to 'exportFullExcelReport' but utilizing the filtered dataset
    },

    // ========================================================
    // 6. EMPLOYEE REGISTRATION (NEW FIELDS)
    // ========================================================
    captureFace: async () => {
        const vid = document.getElementById('reg-video');
        if (!app.faceModelsLoaded) return alert("Loading AI...");

        const det = await faceapi.detectSingleFace(vid).withFaceLandmarks().withFaceDescriptor();

        if (det) {
            app.biometricDescriptor = Array.from(det.descriptor);
            const canvas = document.createElement('canvas');
            canvas.width = 300; canvas.height = 225;
            canvas.getContext('2d').drawImage(vid, 0, 0, 300, 225);
            app.currentPhoto = canvas.toDataURL('image/jpeg', 0.8);

            document.getElementById('reg-face-status').innerText = "Face & Photo Captured!";
            document.getElementById('reg-face-status').className = "text-success fw-bold small mt-1";
        } else alert("No face detected.");
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

        const { error } = await supabaseClient.from('employees').insert([{
            id: id, name: name, unit: unit, designation: desig, 
            mobile: mobile, aadhar: aadhar, address: address, shift: shift,
            face_descriptor: app.biometricDescriptor, photo: app.currentPhoto
        }]);

        if (!error) {
            alert("Staff Registered Successfully!");
            app.loadFaceData();
            bootstrap.Modal.getInstance(document.getElementById('addEmployeeModal')).hide();
            document.getElementById('reg-name').value = ""; // Clear
        } else alert(error.message);
    },

    // ========================================================
    // 7. UTILS: DIRECTORY, UNITS, LOGS
    // ========================================================
    openStaffDirectory: async () => {
        const { data } = await supabaseClient.from('employees').select('*');
        const tbody = document.getElementById('staff-list-body');
        tbody.innerHTML = '';
        if (data) {
            data.forEach(emp => {
                tbody.innerHTML += `<tr><td>${emp.id}</td><td>${emp.name}</td><td>${emp.unit}</td><td><button class="btn btn-sm btn-outline-danger" onclick="app.deleteEmployee('${emp.id}','${emp.name}')">Delete</button></td></tr>`;
            });
        }
        new bootstrap.Modal(document.getElementById('staffDirectoryModal')).show();
    },

    filterStaff: (q) => { const rows = document.getElementById('staff-list-body').getElementsByTagName('tr'); for (let r of rows) r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase()) ? "" : "none"; },
    deleteEmployee: async (id, name) => { if (confirm(`Delete ${name}?`)) { await supabaseClient.from('employees').delete().eq('id', id); alert("Deleted"); app.openStaffDirectory(); app.refreshDashboardData(); app.loadFaceData(); } },

    openAdvancedReports: async () => {
        const { data } = await supabaseClient.from('employees').select('*');
        document.getElementById('report-emp-select').innerHTML = data.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
        new bootstrap.Modal(document.getElementById('reportsModal')).show();
    },

    generateEmployeePDF: async () => {
        const empId = document.getElementById('report-emp-select').value;
        const { data: emp } = await supabaseClient.from('employees').select('*').eq('id', empId).single();
        const { data: logs } = await supabaseClient.from('attendance').select('*').eq('emp_id', empId);

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        doc.text(`Work Report: ${emp.name}`, 14, 20);
        
        if (emp.photo && emp.photo.length > 100) {
            try { doc.addImage(emp.photo, 'JPEG', 150, 25, 35, 35); } catch(e) {}
        }

        doc.autoTable({
            startY: 70,
            head: [['Date', 'In', 'Out', 'Work Log']],
            body: logs.map(l => [l.date, l.check_in, l.check_out || '-', l.work_log || '-']),
        });
        doc.save(`${emp.name}_Report.pdf`);
    },

    generateEmployeeExcel: async () => {
        const empId = document.getElementById('report-emp-select').value;
        const { data: logs } = await supabaseClient.from('attendance').select('*').eq('emp_id', empId);
        const ws = XLSX.utils.json_to_sheet(logs);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Logs");
        XLSX.writeFile(wb, "Employee_Log.xlsx");
    },

    exportFullExcelReport: async () => {
        const { data: emps } = await supabaseClient.from('employees').select('*');
        const { data: logs } = await supabaseClient.from('attendance').select('*');
        const report = emps.map(emp => {
            const eLogs = logs.filter(l => l.emp_id === emp.id);
            return { Name: emp.name, ID: emp.id, Present: eLogs.length };
        });
        const ws = XLSX.utils.json_to_sheet(report);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Master");
        XLSX.writeFile(wb, "Master_Report.xlsx");
    },

    openWorkLog: (id, name, log) => { document.getElementById('logAttId').value = id; document.getElementById('logEmpName').value = name; document.getElementById('logText').value = log; new bootstrap.Modal(document.getElementById('workLogModal')).show(); },
    saveWorkLog: async () => { await supabaseClient.from('attendance').update({ work_log: document.getElementById('logText').value }).eq('id', document.getElementById('logAttId').value); bootstrap.Modal.getInstance(document.getElementById('workLogModal')).hide(); app.refreshDashboardData(); },

    openUnitModal: async () => { const { data } = await supabaseClient.from('units').select('*'); document.getElementById('unit-list').innerHTML = data.map(u => `<li class="list-group-item d-flex justify-content-between">${u.name} <button class="btn btn-sm btn-danger" onclick="app.deleteUnit(${u.id})">&times;</button></li>`).join(''); new bootstrap.Modal(document.getElementById('unitModal')).show(); },
    addUnit: async () => { await supabaseClient.from('units').insert([{ name: document.getElementById('new-unit-name').value }]); app.openUnitModal(); },
    deleteUnit: async (id) => { if (confirm("Delete?")) await supabaseClient.from('units').delete().eq('id', id); app.openUnitModal(); },

    openEmployeeModal: async () => { const { data } = await supabaseClient.from('units').select('*'); document.getElementById('reg-unit').innerHTML = data.map(u => `<option value="${u.name}">${u.name}</option>`).join(''); new bootstrap.Modal(document.getElementById('addEmployeeModal')).show(); navigator.mediaDevices.getUserMedia({ video: {} }).then(s => document.getElementById('reg-video').srcObject = s); },

    showPerformance: async (empId) => {
        const { data: logs } = await supabaseClient.from('attendance').select('*').eq('emp_id', empId).limit(30);
        const labels = logs.map(l => l.date);
        const data = logs.map(l => { if (!l.check_out) return 0; return ((new Date(`1970-01-01T${l.check_out}`) - new Date(`1970-01-01T${l.check_in}`)) / 36e5).toFixed(1); });
        const ctx = document.getElementById('perfChart').getContext('2d');
        if (app.perfChartInstance) app.perfChartInstance.destroy();
        app.perfChartInstance = new Chart(ctx, { type: 'bar', data: { labels, datasets: [{ label: 'Hours', data }] } });
        new bootstrap.Modal(document.getElementById('performanceModal')).show();
    },

    // ========================================================
    // 8. ADMIN BACKEND (IT ONLY)
    // ========================================================
    updateLicense: async () => {
        const date = document.getElementById('license-date').value;
        if(!date) return alert("Select date");
        await supabaseClient.from('system_settings').upsert({ setting_key: 'license_expiry', setting_value: date });
        alert("License Updated");
    },
    wipeAttendanceData: async () => {
        if(prompt("PIN:") === "2026") { await supabaseClient.from('attendance').delete().neq('id', 0); alert("Wiped Attendance"); }
    },
    wipeEmployeeData: async () => {
        if(prompt("PIN:") === "2026") { await supabaseClient.from('employees').delete().neq('id', '0'); alert("Wiped Employees"); }
    },
    toggleSystemLock: async (e) => { await supabaseClient.from('system_settings').upsert({ setting_key: 'system_lock', setting_value: e.target.checked ? 'active' : 'locked' }); app.systemLocked = !e.target.checked; },

    // ========================================================
    // 9. ATTENDANCE SCANNER
    // ========================================================
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
        const { data: emp } = await supabaseClient.from('employees').select('*').eq('name', name).single();
        if (!emp) return;

        const last = app.lastScanMap.get(emp.id);
        if (last && (dateObj.getTime() - last < app.SCAN_COOLDOWN)) return; // Debounce

        let shiftDate = new Date(dateObj);
        if (hour < 4) shiftDate.setDate(shiftDate.getDate() - 1);
        const shiftDateStr = shiftDate.toISOString().split('T')[0];
        const timeNowStr = dateObj.toLocaleTimeString('en-GB');

        const { data: att } = await supabaseClient.from('attendance').select('*').eq('emp_id', emp.id).eq('date', shiftDateStr).single();

        let msg = "", type = "success", voiceMsg = "";

        // ZONE A: MORNING (04:00 - 11:59)
        if (hour >= 4 && hour < 12) {
            if (!att) {
                await supabaseClient.from('attendance').insert([{ emp_id: emp.id, name: name, unit: emp.unit, date: shiftDateStr, check_in: timeNowStr }]);
                msg = `Checked In`; voiceMsg = `Good Morning ${name}.`;
            } else {
                msg = `Already Checked In`; type = "secondary"; voiceMsg = `Already checked in.`;
            }
        } 
        // ZONE B: LUNCH (12:00 - 15:59)
        else if (hour >= 12 && hour < 16) {
            if (att) {
                if (!att.lunch_out) {
                    await supabaseClient.from('attendance').update({ lunch_out: timeNowStr }).eq('id', att.id);
                    msg = `Lunch Start`; type = "warning"; voiceMsg = `Enjoy lunch.`;
                } else if (!att.lunch_in) {
                    await supabaseClient.from('attendance').update({ lunch_in: timeNowStr }).eq('id', att.id);
                    msg = `Lunch End`; voiceMsg = `Welcome back.`;
                } else {
                    msg = `Lunch Done`; type = "secondary";
                }
            } else {
                await supabaseClient.from('attendance').insert([{ emp_id: emp.id, name: name, unit: emp.unit, date: shiftDateStr, check_in: timeNowStr }]);
                msg = `Late Check-in`; type = "warning"; voiceMsg = `Late check-in recorded.`;
            }
        } 
        // ZONE C: NIGHT (16:00 - 03:59)
        else {
            if (att) {
                await supabaseClient.from('attendance').update({ check_out: timeNowStr }).eq('id', att.id);
                msg = `Checked Out`; type = "info"; voiceMsg = `Shift Ended.`;
            } else {
                // FIXED: Night shift check-in
                await supabaseClient.from('attendance').insert([{ emp_id: emp.id, name: name, unit: emp.unit, date: shiftDateStr, check_in: timeNowStr }]);
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

    // ========================================================
    // 10. KIOSK & UTILS
    // ========================================================
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
                        
                        // INSTANT LOCK (DEBOUNCE)
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
            if(document.getElementById('weather-temp')) document.getElementById('weather-temp').innerText = t; 
            if(document.getElementById('mob-weather')) document.getElementById('mob-weather').innerText = t; 
            if(document.getElementById('mob-aqi')) document.getElementById('mob-aqi').innerText = q;
            if(document.getElementById('mob-aqi-nav')) document.getElementById('mob-aqi-nav').innerText = q;
        } catch (e) { } 
    },
    
    loadFaceData: async () => { const { data } = await supabaseClient.from('employees').select('name, face_descriptor'); if (data) app.labeledDescriptors = data.filter(e => e.face_descriptor).map(e => new faceapi.LabeledFaceDescriptors(e.name, [new Float32Array(e.face_descriptor)])); },
    
    selectDate: (d) => { app.selectedDateStr = d; app.isOverallView = false; app.refreshDashboardData(); },
    resetToToday: () => { app.selectedDateStr = new Date().toISOString().split('T')[0]; app.isOverallView = false; app.refreshDashboardData(); },
    changeMonth: (d) => { app.currentDate.setMonth(app.currentDate.getMonth() + d); app.renderCalendar(); },
    renderCalendar: () => { const g=document.getElementById('calendar-grid'); if(!g)return; g.innerHTML=''; const y=app.currentDate.getFullYear(); const m=app.currentDate.getMonth(); document.getElementById('calendar-month-year').innerText=new Date(y,m).toLocaleDateString('en-US',{month:'short',year:'numeric'}); ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d=>g.innerHTML+=`<div class="calendar-day-header">${d}</div>`); const f=new Date(y,m,1).getDay(); const days=new Date(y,m+1,0).getDate(); for(let i=0;i<f;i++)g.innerHTML+=`<div></div>`; for(let d=1;d<=days;d++){ const dt=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; g.innerHTML+=`<div class="calendar-day ${dt===app.selectedDateStr?'active':''}" onclick="app.selectDate('${dt}')">${d}</div>`; } }
};

document.addEventListener('DOMContentLoaded', app.init);
