// @block /sheet.js
// Without the grid library, a plain sortable table shows every job.
const rows = document.querySelectorAll("#sheet tbody tr").length;
check("no grid", !window.jspreadsheet && grid === null);
check("plain table with every job", rows > 0 && `${rows} jobs` === document.getElementById("count").textContent, rows);
check("headers sort", document.querySelectorAll("#sheet th button").length > 5);
