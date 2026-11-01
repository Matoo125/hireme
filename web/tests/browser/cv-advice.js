// CV advice: shown only with a CV, renders saved suggestions, marks them stale
// after a new CV, and says so when there are no jobs to compare the CV with.
const box = document.getElementById("cvAdvice");
const info = document.getElementById("cvAdviceInfo");
const auth = { Authorization: `Bearer ${TOKENS.user}` };
const upload = (bytes) => fetch("/api/cv?filename=cv.pdf", {
  method: "POST", headers: { ...auth, "Content-Type": "application/pdf" }, body: bytes,
});

check("logged out: API refuses", (await fetch("/api/cv/advice")).status === 401);

await signIn("user");
const none = await (await fetch("/api/cv/advice", { headers: auth })).json();
check("no CV: status no-cv, no advice", none.status === "no-cv" && none.advice === null, JSON.stringify(none));
const early = await fetch("/api/cv/advice", { method: "POST", headers: auth });
check("no CV: asking is refused", early.status === 400, early.status);

await upload("%PDF-1.4 test cv");
await loadCvInfo();
await wait(300);
check("with a CV: advice box shown", box.hidden === false);
const body = document.getElementById("cvAdviceBody");
check("saved advice rendered", body.textContent.includes("Lead with policy work")
  && body.textContent.includes("Helps with: First job – First org")
  && body.textContent.includes("Clear publication list"), body.textContent.slice(0, 200));
check("button offers to suggest again", document.getElementById("cvAdviceBtn").textContent === "Suggest again");

await upload("%PDF-1.4 newer cv");
await loadCvInfo();
await wait(300);
check("new CV: marked stale, still shown", info.textContent.includes("previous CV") && body.hidden === false,
  info.textContent);

// The test server has no liked, tracked or scored jobs in its data dir for
// this user, so the script stops before calling Claude and says why.
await requestAdvice();
for (let i = 0; i < 40 && !info.classList.contains("cv-status--error"); i++) {
  await wait(500);
  await loadAdvice();
}
check("no jobs to compare with: says so", info.textContent.includes("Like or track a few jobs first"), info.textContent);

await fetch("/api/cv", { method: "DELETE", headers: auth });
const gone = await (await fetch("/api/cv/advice", { headers: auth })).json();
check("CV deleted: advice deleted too", gone.status === "no-cv" && gone.advice === null, JSON.stringify(gone));
