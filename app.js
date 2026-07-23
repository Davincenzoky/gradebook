let SQL, db, currentPage = 'home', currentClassId = null, currentStudentId = null
const ASSESSMENT_TYPES = ['Quiz', 'Exam', 'Assignment', 'Project', 'Recitation', 'Other']

async function initSQL() {
  SQL = await initSqlJs({ locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/${file}` })
  const saved = localStorage.getItem('gradebook_db')
  if (saved) {
    const buf = Uint8Array.from(atob(saved), c => c.charCodeAt(0))
    db = new SQL.Database(buf)
  } else {
    db = new SQL.Database()
  }
  db.run(`CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY AUTOINCREMENT, sectionName TEXT NOT NULL, subjectCode TEXT NOT NULL, instructor TEXT DEFAULT '', academicYear TEXT DEFAULT '', createdAt TEXT DEFAULT (datetime('now')))`)
  db.run(`CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY AUTOINCREMENT, studentNumber TEXT NOT NULL, name TEXT NOT NULL, classId INTEGER NOT NULL, FOREIGN KEY (classId) REFERENCES classes(id) ON DELETE CASCADE)`)
  db.run(`CREATE TABLE IF NOT EXISTS grades (id INTEGER PRIMARY KEY AUTOINCREMENT, studentId INTEGER NOT NULL, assessmentName TEXT NOT NULL, score REAL DEFAULT 0, maxScore REAL DEFAULT 100, assessmentType TEXT DEFAULT 'Quiz', date TEXT DEFAULT (date('now')), FOREIGN KEY (studentId) REFERENCES students(id) ON DELETE CASCADE)`)
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
}

function saveDB() {
  const data = db.export()
  const binary = new Uint8Array(data)
  let binaryStr = ''
  for (let i = 0; i < binary.length; i++) binaryStr += String.fromCharCode(binary[i])
  localStorage.setItem('gradebook_db', btoa(binaryStr))
}

function q(sql, params = {}) {
  return db.exec(sql, params)
}

function all(sql, params = {}) {
  const stmt = db.prepare(sql)
  if (Object.keys(params).length) stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

function get(sql, params = {}) {
  const rows = all(sql, params)
  return rows.length ? rows[0] : null
}

function run(sql, params = {}) {
  db.run(sql, params)
  saveDB()
}

function esc(s) { return `"${String(s).replace(/"/g, '""')}"` }

// --- CLASSES ---
function getClasses(archived) {
  const allClasses = all(`SELECT c.*,
    (SELECT COUNT(*) FROM students WHERE classId = c.id) as studentCount,
    COALESCE((SELECT AVG(g.score / g.maxScore * 100) FROM students s JOIN grades g ON g.studentId = s.id WHERE s.classId = c.id), 0) as averageGrade
    FROM classes c ORDER BY c.createdAt DESC`)
  const archivedIds = getArchivedIds()
  return allClasses.filter(c => archived ? archivedIds.includes(c.id) : !archivedIds.includes(c.id))
}

function addClass(section, code, instructor, year) {
  run(`INSERT INTO classes (sectionName, subjectCode, instructor, academicYear) VALUES ($s, $c, $i, $y)`,
    { $s: section, $c: code, $i: instructor, $y: year })
}

function deleteClass(id) {
  const s = all(`SELECT id FROM students WHERE classId = $id`, { $id: id })
  for (const st of s) run(`DELETE FROM grades WHERE studentId = $sid`, { $sid: st.id })
  run(`DELETE FROM students WHERE classId = $id`, { $id })
  run(`DELETE FROM classes WHERE id = $id`, { $id })
}

function getArchivedIds() {
  return JSON.parse(getSetting('archived_classes') || '[]')
}

function setArchivedIds(ids) {
  setSetting('archived_classes', JSON.stringify(ids))
}

function archiveClass(id) {
  const ids = getArchivedIds()
  if (!ids.includes(id)) ids.push(id)
  setArchivedIds(ids)
}

function unarchiveClass(id) {
  setArchivedIds(getArchivedIds().filter(x => x !== id))
}

// --- STUDENTS ---
function getStudents(classId) {
  return all(`SELECT s.*, COALESCE((SELECT AVG(g.score / g.maxScore * 100) FROM grades g WHERE g.studentId = s.id), 0) as average
    FROM students s WHERE s.classId = $id ORDER BY s.studentNumber`, { $id: classId })
}

function addStudent(num, name, classId) {
  run(`INSERT INTO students (studentNumber, name, classId) VALUES ($n, $m, $c)`, { $n: num, $m: name, $c: classId })
}

function deleteStudent(id) {
  run(`DELETE FROM grades WHERE studentId = $id`, { $id: id })
  run(`DELETE FROM students WHERE id = $id`, { $id })
}

function bulkInsertStudents(classId, students) {
  for (const s of students) addStudent(s.studentNumber, s.name, classId)
}

// --- GRADES ---
function getGradesForClass(classId) {
  return all(`SELECT g.*, s.name as studentName, s.studentNumber FROM grades g JOIN students s ON s.id = g.studentId WHERE s.classId = $id ORDER BY s.studentNumber, g.assessmentName`, { $id: classId })
}

function getGradesForStudent(studentId) {
  return all(`SELECT * FROM grades WHERE studentId = $id ORDER BY date DESC`, { $id: studentId })
}

function getDistinctAssessments(classId) {
  const fromGrades = all(`SELECT DISTINCT g.assessmentName, g.maxScore, g.assessmentType FROM grades g JOIN students s ON s.id = g.studentId WHERE s.classId = $id ORDER BY g.assessmentName`, { $id: classId })
  const key = `assessments_${classId}`
  const stored = JSON.parse(getSetting(key) || '[]')
  const map = {}
  for (const a of [...fromGrades, ...stored]) map[a.assessmentName] = a
  return Object.values(map).sort((a, b) => a.assessmentName.localeCompare(b.assessmentName))
}

function addAssessmentDef(classId, name, maxScore, type) {
  const key = `assessments_${classId}`
  const existing = JSON.parse(getSetting(key) || '[]')
  existing.push({ assessmentName: name, maxScore, assessmentType: type })
  setSetting(key, JSON.stringify(existing))
}

function addGrade(studentId, name, score, maxScore, type, date) {
  const existing = all(`SELECT id FROM grades WHERE studentId = $sid AND assessmentName = $an`, { $sid: studentId, $an: name })
  if (existing.length) {
    run(`UPDATE grades SET score = $sc, maxScore = $ms, assessmentType = $at, date = $d WHERE id = $id`,
      { $sc: score, $ms: maxScore, $at: type, $d: date, $id: existing[0].id })
  } else {
    run(`INSERT INTO grades (studentId, assessmentName, score, maxScore, assessmentType, date) VALUES ($sid, $an, $sc, $ms, $at, $d)`,
      { $sid: studentId, $an: name, $sc: score, $ms: maxScore, $at: type, $d: date })
  }
}

function updateAssessment(classId, oldName, newName, maxScore, type) {
  run(`UPDATE grades SET assessmentName = $nn, maxScore = $ms, assessmentType = $at WHERE assessmentName = $on AND studentId IN (SELECT id FROM students WHERE classId = $cid)`,
    { $nn: newName, $ms: maxScore, $at: type, $on: oldName, $cid: classId })
  const key = `assessments_${classId}`
  const stored = JSON.parse(getSetting(key) || '[]').map(a =>
    a.assessmentName === oldName ? { assessmentName: newName, maxScore, assessmentType: type } : a)
  setSetting(key, JSON.stringify(stored))
}

function deleteAssessment(classId, name) {
  run(`DELETE FROM grades WHERE assessmentName = $an AND studentId IN (SELECT id FROM students WHERE classId = $cid)`,
    { $an: name, $cid: classId })
  const key = `assessments_${classId}`
  const stored = JSON.parse(getSetting(key) || '[]').filter(a => a.assessmentName !== name)
  setSetting(key, JSON.stringify(stored))
}

// --- SETTINGS ---
function getSetting(key) {
  const r = get(`SELECT value FROM settings WHERE key = $k`, { $k: key })
  return r ? r.value : null
}

function setSetting(key, value) {
  run(`INSERT OR REPLACE INTO settings (key, value) VALUES ($k, $v)`, { $k: key, $v: value })
}

// --- EXPORT CSV ---
function exportAllStudents() {
  const classes = getClasses()
  if (!classes.length) return
  const allAssess = new Set()
  for (const c of classes) {
    const a = getDistinctAssessments(c.id)
    a.forEach(x => allAssess.add(x.assessmentName))
  }
  const assessments = [...allAssess]
  let csv = ['Subject,Student Number,Student Name,' + assessments.join(',') + ',Percentage']
  for (const c of classes) {
    const students = getStudents(c.id)
    for (const s of students) {
      const grades = all(`SELECT * FROM grades WHERE studentId = $id`, { $id: s.id })
      const map = {}
      let total = 0, maxTotal = 0
      for (const g of grades) map[g.assessmentName] = g
      const scores = assessments.map(a => {
        const f = map[a]
        if (f) { total += f.score; maxTotal += f.maxScore; return String(f.score) }
        return ''
      })
      const pct = maxTotal > 0 ? ((total / maxTotal) * 100).toFixed(1) + '%' : ''
      csv.push([`${c.sectionName} - ${c.subjectCode}`, s.studentNumber, s.name, ...scores, pct].map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    }
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'gradebook_export.csv'; a.click()
  URL.revokeObjectURL(url)
}

// --- THEME ---
function initTheme() {
  const saved = localStorage.getItem('theme')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = saved ? saved === 'dark' : prefersDark
  document.documentElement.classList.toggle('dark', isDark)
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark')
  localStorage.setItem('theme', isDark ? 'dark' : 'light')
}

// --- ROUTER ---
function navigate(page, data) {
  currentPage = page
  if (data) {
    if (data.classId !== undefined) currentClassId = data.classId
    if (data.studentId !== undefined) currentStudentId = data.studentId
  }
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'))
  const el = document.getElementById(`page-${page}`)
  if (el) el.classList.remove('hidden')
  renderPage()
}

// --- RENDER ---
function renderPage() {
  switch (currentPage) {
    case 'home': renderHome(); break
    case 'class': renderClassDetail(); break
    case 'grade-entry': renderGradeEntry(); break
    case 'grade-report': renderGradeReport(); break
    case 'import': renderImport(); break
  }
}

function renderHome() {
  const active = getClasses(false)
  const archived = getClasses(true)
  const container = document.getElementById('home-classes')
  if (!active.length && !archived.length) {
    container.innerHTML = `<div class="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500">
      <p class="text-lg font-bold">No classes yet</p>
      <p class="text-sm mt-1">Tap + to add your first class</p>
    </div>`
    return
  }
  let html = ''
  if (!active.length) {
    html += `<div class="flex flex-col items-center justify-center py-10 text-gray-400 dark:text-gray-500"><p class="text-lg font-bold">No active classes</p></div>`
  } else {
    html += active.map(c => classCard(c, false)).join('')
  }
  if (archived.length) {
    html += `<div class="mt-6 mb-2 px-1 flex justify-between items-center">
      <span class="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Archived (${archived.length})</span>
      <button onclick="document.getElementById('archived-list').classList.toggle('hidden')" class="text-xs text-blue-500 border-none bg-transparent cursor-pointer">Toggle</button>
    </div>
    <div id="archived-list" class="hidden">${archived.map(c => classCard(c, true)).join('')}</div>`
  }
  container.innerHTML = html
}

let openMenuId = null
document.addEventListener('click', () => {
  if (openMenuId !== null) { openMenuId = null; if (currentPage === 'home') renderHome() }
})

function classCard(c, isArchived) {
  const avg = Number(c.averageGrade).toFixed(1)
  const show = openMenuId === c.id
  return `<div class="bg-white dark:bg-gray-800 rounded-xl p-4 mb-3 shadow cursor-pointer hover:shadow-md transition relative ${isArchived ? 'opacity-60' : ''}">
    <div onclick="navigate('class',{classId:${c.id}})" class="flex justify-between items-center">
      <span class="text-lg font-bold text-gray-800 dark:text-white">${escHTML(c.sectionName)}</span>
      <span class="text-sm px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">${escHTML(c.subjectCode)}</span>
    </div>
    <div onclick="navigate('class',{classId:${c.id}})" class="flex gap-4 mt-2 text-sm text-gray-500 dark:text-gray-400">
      <span>Students: ${c.studentCount}</span>
      <span>Avg: ${c.studentCount > 0 ? avg + '%' : 'N/A'}</span>
    </div>
    ${c.instructor ? `<div onclick="navigate('class',{classId:${c.id}})" class="text-xs text-gray-400 dark:text-gray-500 mt-1">${escHTML(c.instructor)}</div>` : ''}
    <button onclick="event.stopPropagation();toggleMenu(${c.id})" class="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 border-none bg-transparent cursor-pointer text-gray-500 dark:text-gray-400 text-lg">⋮</button>
    ${show ? `<div class="absolute top-10 right-3 bg-white dark:bg-gray-700 rounded-xl shadow-lg border border-gray-200 dark:border-gray-600 z-20 min-w-[140px] overflow-hidden">
      <button onclick="event.stopPropagation();classAction(${c.id},'${isArchived ? 'unarchive' : 'archive'}')" class="w-full px-4 py-3 text-sm text-left border-none bg-transparent cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 flex items-center gap-2">${isArchived ? '📂 Unarchive' : '📦 Archive'}</button>
      <button onclick="event.stopPropagation();classAction(${c.id},'delete')" class="w-full px-4 py-3 text-sm text-left border-none bg-transparent cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 text-red-500 flex items-center gap-2">🗑 Delete</button>
    </div>` : ''}
  </div>`
}

function toggleMenu(id) {
  openMenuId = openMenuId === id ? null : id
  renderHome()
}

function classAction(id, action) {
  if (action === 'delete') {
    const s = getStudents(id)
    const msg = s.length ? `Delete "${get(`SELECT sectionName FROM classes WHERE id=$id`,{$id}).sectionName}" with ${s.length} student${s.length > 1 ? 's' : ''}?` : 'Delete this class?'
    if (!confirm(msg)) { openMenuId = null; renderHome(); return }
    deleteClass(id)
  } else if (action === 'archive') {
    archiveClass(id)
  } else if (action === 'unarchive') {
    unarchiveClass(id)
  }
  openMenuId = null
  renderHome()
}

function renderClassDetail() {
  const cls = get(`SELECT * FROM classes WHERE id = $id`, { $id: currentClassId })
  if (!cls) { navigate('home'); return }
  const isArchived = getArchivedIds().includes(currentClassId)
  const header = document.getElementById('class-header')
  header.innerHTML = `<div class="flex items-center gap-2">
    <button onclick="navigate('home')" class="text-blue-500 text-lg font-medium">← Back</button>
    <h1 class="text-xl font-bold flex-1">${escHTML(cls.sectionName)}</h1>
    <div class="flex gap-1">
      <button onclick="${isArchived ? `unarchiveClass(${currentClassId});renderPage()` : `archiveClass(${currentClassId});renderPage()`}" class="px-3 py-1.5 rounded-lg text-xs font-semibold border-none cursor-pointer ${isArchived ? 'bg-green-500 text-white hover:bg-green-600' : 'bg-yellow-500 text-white hover:bg-yellow-600'} transition">${isArchived ? 'Unarchive' : 'Archive'}</button>
      <button onclick="deleteClassConfirm()" class="px-3 py-1.5 rounded-lg text-xs font-semibold border-none cursor-pointer bg-red-500 text-white hover:bg-red-600 transition">Delete</button>
    </div>
  </div>
  <div class="text-sm text-gray-500 dark:text-gray-400 ml-1">${escHTML(cls.subjectCode)}${cls.instructor ? ' · ' + escHTML(cls.instructor) : ''}${cls.academicYear ? ' · ' + escHTML(cls.academicYear) : ''}</div>`

  const students = getStudents(currentClassId)
  const search = (document.getElementById('student-search')?.value || '').toLowerCase()
  const filtered = search ? students.filter(s => s.name.toLowerCase().includes(search) || s.studentNumber.toLowerCase().includes(search)) : students
  const container = document.getElementById('class-students')
  if (!filtered.length) {
    container.innerHTML = `<div class="flex flex-col items-center justify-center py-16 text-gray-400 dark:text-gray-500">
      <p class="text-lg font-bold">${search ? 'No matching students' : 'No students yet'}</p>
      <p class="text-sm mt-1">${search ? 'Try a different search' : 'Add students or import from CSV'}</p>
    </div>`
    return
  }
  container.innerHTML = filtered.map(s => {
    const avg = Number(s.average).toFixed(1)
    return `<div onclick="navigate('grade-report',{studentId:${s.id}})" class="flex justify-between items-center bg-white dark:bg-gray-800 rounded-xl px-4 py-3.5 mb-2 shadow-sm cursor-pointer hover:shadow transition group">
      <div><div class="text-xs text-gray-400 dark:text-gray-500">${escHTML(s.studentNumber)}</div><div class="text-base text-gray-800 dark:text-white mt-0.5">${escHTML(s.name)}</div></div>
      <div class="flex items-center gap-2">
        <span class="text-blue-600 dark:text-blue-400 font-bold">${avg}%</span>
        <span onclick="event.stopPropagation();deleteStudentConfirm(${s.id},'${escHTML(s.name)}')" class="text-red-400 opacity-0 group-hover:opacity-100 transition cursor-pointer text-lg">×</span>
      </div>
    </div>`
  }).join('')
}

function renderGradeEntry() {
  const students = getStudents(currentClassId)
  const assessments = getDistinctAssessments(currentClassId)
  const gradeData = getGradesForClass(currentClassId)
  const gradeMap = {}
  for (const g of gradeData) {
    if (!gradeMap[g.studentId]) gradeMap[g.studentId] = {}
    gradeMap[g.studentId][g.assessmentName] = g.score
  }

  const container = document.getElementById('grade-entry-grid')
  if (!assessments.length && !students.length) {
    container.innerHTML = '<div class="p-8 text-center text-gray-400">No students or assessments yet</div>'
    return
  }

  let html = `<div class="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 sticky top-0" style="min-width:${80 + assessments.length * 90}px">
    <div class="w-20 p-2 font-bold text-sm text-gray-700 dark:text-gray-300 shrink-0">Student</div>
    <div class="w-16 p-2 font-bold text-sm text-gray-700 dark:text-gray-300 shrink-0 text-center">Total</div>
    ${assessments.map(a => `<div onclick="editAssessment('${escHTML(a.assessmentName)}',${a.maxScore},'${a.assessmentType}')" class="w-[90px] shrink-0 p-2 text-center border-l border-gray-200 dark:border-gray-700 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/50">
      <div class="text-xs font-bold text-gray-700 dark:text-gray-300">${escHTML(a.assessmentName)}</div>
      <div class="text-[10px] text-gray-400">/${a.maxScore}</div>
      <div class="text-[10px] text-blue-600 dark:text-blue-400">${a.assessmentType}</div>
    </div>`).join('')}
  </div>`

  for (const s of students) {
    let total = 0, maxTotal = 0
    const scores = assessments.map(a => {
      const val = gradeMap[s.id]?.[a.assessmentName]
      if (val !== undefined) { total += val; maxTotal += a.maxScore; return val }
      return ''
    })
    const pct = maxTotal > 0 ? ((total / maxTotal) * 100).toFixed(1) : '-'
    html += `<div class="flex border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/30" style="min-width:${80 + assessments.length * 90}px">
      <div class="w-20 p-2 text-xs text-gray-600 dark:text-gray-400 shrink-0"><div class="truncate">${escHTML(s.studentNumber)}</div><div class="text-sm text-gray-800 dark:text-gray-200 truncate">${escHTML(s.name)}</div></div>
      <div class="w-16 p-2 text-center shrink-0"><div class="font-semibold text-sm text-gray-800 dark:text-gray-200">${total}</div><div class="text-xs ${pct !== '-' && parseFloat(pct) < 60 ? 'text-red-500' : 'text-gray-500'}">${pct}%</div></div>
      ${assessments.map(a => {
        const val = gradeMap[s.id]?.[a.assessmentName]
        return `<div class="w-[90px] shrink-0 p-1.5 border-l border-gray-100 dark:border-gray-700/50">
          <input type="number" value="${val !== undefined ? val : ''}" max="${a.maxScore}" onchange="saveGrade(${s.id},'${a.assessmentName}',this.value,${a.maxScore},'${a.assessmentType}')" onfocus="this.select()" placeholder="-" class="w-full text-center text-sm border border-gray-200 dark:border-gray-600 rounded-md px-1 py-1.5 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none" />
        </div>`
      }).join('')}
    </div>`
  }
  container.innerHTML = html
}

function renderGradeReport() {
  const grades = getGradesForStudent(currentStudentId)
  const container = document.getElementById('grade-report-content')
  const avg = grades.length ? (grades.reduce((s, g) => s + (g.score / g.maxScore) * 100, 0) / grades.length).toFixed(1) : '0.0'
  document.getElementById('report-avg').textContent = avg + '%'
  if (!grades.length) {
    container.innerHTML = '<div class="p-8 text-center text-gray-400">No grades recorded yet</div>'
    return
  }
  container.innerHTML = grades.map(g => {
    const pct = (g.score / g.maxScore) * 100
    return `<div class="bg-white dark:bg-gray-800 rounded-xl p-4 mb-2 shadow-sm">
      <div class="flex justify-between"><span class="font-semibold text-gray-800 dark:text-gray-200">${escHTML(g.assessmentName)}</span><span class="text-xs px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">${escHTML(g.assessmentType)}</span></div>
      <div class="flex justify-between items-center mt-2"><span class="text-gray-500 dark:text-gray-400">${g.score} / ${g.maxScore}</span><span class="text-xl font-bold ${pct >= 60 ? 'text-green-500' : 'text-red-500'}">${pct.toFixed(1)}%</span></div>
      <div class="text-xs text-gray-400 dark:text-gray-500 mt-1">${g.date}</div>
    </div>`
  }).join('')
}

function renderImport() {
  document.getElementById('import-status').textContent = ''
}

// --- ACTIONS ---
function deleteStudentConfirm(id, name) {
  if (confirm(`Remove ${name}?`)) { deleteStudent(id); renderPage() }
}

function deleteClassConfirm() {
  const cls = get(`SELECT sectionName FROM classes WHERE id=$id`,{$id:currentClassId})
  const s = getStudents(currentClassId)
  const msg = s.length ? `Delete "${cls.sectionName}" with ${s.length} student${s.length > 1 ? 's' : ''}?` : `Delete "${cls.sectionName}"?`
  if (!confirm(msg)) return
  deleteClass(currentClassId)
  navigate('home')
}

function saveGrade(studentId, name, val, maxScore, type) {
  const num = parseFloat(val)
  if (isNaN(num)) return
  if (num > maxScore) { alert(`Score cannot exceed ${maxScore}`); renderPage(); return }
  addGrade(studentId, name, num, maxScore, type, new Date().toISOString().split('T')[0])
}

function showAddClass() { document.getElementById('modal-add-class').classList.remove('hidden') }
function hideAddClass() { document.getElementById('modal-add-class').classList.add('hidden') }

function submitClass() {
  const section = document.getElementById('input-section').value.trim()
  const code = document.getElementById('input-code').value.trim()
  if (!section || !code) { alert('Section name and subject code are required.'); return }
  addClass(section, code, document.getElementById('input-instructor').value.trim(), document.getElementById('input-year').value.trim())
  document.getElementById('input-section').value = ''
  document.getElementById('input-code').value = ''
  document.getElementById('input-instructor').value = ''
  document.getElementById('input-year').value = ''
  hideAddClass()
  renderHome()
}

function showAddStudent() { document.getElementById('modal-add-student').classList.remove('hidden') }
function hideAddStudent() { document.getElementById('modal-add-student').classList.add('hidden') }

function submitStudent() {
  const num = document.getElementById('input-student-num').value.trim()
  const name = document.getElementById('input-student-name').value.trim()
  if (!num || !name) { alert('Student number and name are required.'); return }
  addStudent(num, name, currentClassId)
  document.getElementById('input-student-num').value = ''
  document.getElementById('input-student-name').value = ''
  hideAddStudent()
  renderPage()
}

function showAddAssessment() {
  document.getElementById('modal-assessment-title').textContent = 'New Assessment'
  document.getElementById('input-assessment-name').value = ''
  document.getElementById('input-assessment-max').value = '100'
  document.getElementById('input-assessment-type').value = 'Quiz'
  document.getElementById('modal-assessment').dataset.mode = 'add'
  document.getElementById('modal-assessment').dataset.oldName = ''
  document.getElementById('btn-delete-assessment').classList.add('hidden')
  document.getElementById('modal-assessment').classList.remove('hidden')
}

function editAssessment(name, maxScore, type) {
  document.getElementById('modal-assessment-title').textContent = 'Edit Assessment'
  document.getElementById('input-assessment-name').value = name
  document.getElementById('input-assessment-max').value = maxScore
  document.getElementById('input-assessment-type').value = type
  document.getElementById('modal-assessment').dataset.mode = 'edit'
  document.getElementById('modal-assessment').dataset.oldName = name
  document.getElementById('btn-delete-assessment').classList.remove('hidden')
  document.getElementById('modal-assessment').classList.remove('hidden')
}

function submitAssessment() {
  const name = document.getElementById('input-assessment-name').value.trim()
  const max = parseFloat(document.getElementById('input-assessment-max').value) || 100
  const type = document.getElementById('input-assessment-type').value
  const mode = document.getElementById('modal-assessment').dataset.mode
  const oldName = document.getElementById('modal-assessment').dataset.oldName
  if (!name) { alert('Assessment name is required.'); return }
  if (mode === 'add') {
    addAssessmentDef(currentClassId, name, max, type)
  } else {
    updateAssessment(currentClassId, oldName, name, max, type)
  }
  document.getElementById('modal-assessment').classList.add('hidden')
  renderPage()
}

function deleteAssessmentConfirm() {
  const name = document.getElementById('input-assessment-name').value.trim()
  if (!confirm(`Delete "${name}" and all its grades?`)) return
  deleteAssessment(currentClassId, name)
  document.getElementById('modal-assessment').classList.add('hidden')
  renderPage()
}

function importStudents() {
  const text = document.getElementById('import-text').value.trim()
  if (!text) return
  const lines = text.trim().split('\n').filter(l => l.trim())
  const students = []
  for (const line of lines) {
    let parts, num, name
    if (line.includes('|')) {
      parts = line.split('|').map(s => s.trim())
      const first = parts.shift() || ''
      const m = first.match(/^(\d+)(.*)/)
      if (m) {
        num = m[1]
        name = (m[2] + ' ' + parts.join(' ')).trim().replace(/^"|"$/g, '')
      } else {
        num = first
        name = parts.join(' ').replace(/^"|"$/g, '')
      }
    } else if (line.includes('\t')) {
      parts = line.split('\t')
      num = (parts[0] || '').trim()
      name = (parts.slice(1).join(' ') || '').trim().replace(/^"|"$/g, '')
    } else if (line.includes(',')) {
      parts = line.split(',')
      num = (parts[0] || '').trim()
      name = (parts.slice(1).join(' ') || '').trim().replace(/^"|"$/g, '')
    } else {
      parts = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]
      num = (parts[0] || '').trim()
      name = (parts.slice(1).join(' ') || '').trim().replace(/^"|"$/g, '')
    }
    if (num && name) students.push({ studentNumber: num, name })
  }
  if (!students.length) { alert('No valid student data found.'); return }
  if (!confirm(`Found ${students.length} students. Import all?`)) return
  bulkInsertStudents(currentClassId, students)
  document.getElementById('import-text').value = ''
  document.getElementById('import-status').textContent = `${students.length} students imported successfully!`
  document.getElementById('import-status').className = 'text-sm text-green-500 mt-2'
}

function escHTML(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

document.addEventListener('DOMContentLoaded', async () => {
  await initSQL()
  initTheme()
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'))
  document.getElementById('page-home').classList.remove('hidden')
  renderHome()
})
