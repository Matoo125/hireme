// Saved answers: a sidebar section, logged in only, starting from five starter
// questions; an edited field saves the whole list on blur; markup stays text.
const section = document.getElementById("answersSection");
const auth = { Authorization: `Bearer ${TOKENS.user}` };
const entries = () => [...section.querySelectorAll(".answer-entry")];
const server = async () => (await (await fetch("/api/answers", { headers: auth })).json()).answers;
const blur = (field) => field.dispatchEvent(new Event("change", { bubbles: true }));

check("hidden logged out", section.hidden);
check("API refuses logged out", (await fetch("/api/answers")).status === 401);

await signIn("user");
updateAuthUI(); // signIn sets the token only
for (let i = 0; i < 20 && !entries().length; i++) await wait(100);
check("shown logged in", !section.hidden);
check("five starter questions", entries().length === 5 && entries()[1].querySelector(".answer-question").value === "Salary expectations",
  String(entries().length));
check("starters marked not answered", /not answered yet/i.test(entries()[1].textContent));

const salary = entries()[1].querySelector(".answer-text");
salary.value = "<b>60k</b>";
blur(salary);
await wait(300);
const saved = await server();
check("saved on change", saved.find((a) => a.question === "Salary expectations")?.answer === "<b>60k</b>", JSON.stringify(saved));
check("saves the whole list", saved.length === 5);
check("markup stays text", !section.querySelector("b") && salary.value === "<b>60k</b>");

section.querySelector(".answers-add").click();
const added = entries().at(-1);
added.querySelector(".answer-question").value = "Pronouns";
added.querySelector(".answer-text").value = "they/them";
blur(added.querySelector(".answer-text"));
await wait(300);
check("added question saved", (await server()).some((a) => a.question === "Pronouns" && a.answer === "they/them"));

entries().at(-1).querySelector(".answer-remove").click();
await wait(300);
check("removed", !(await server()).some((a) => a.question === "Pronouns") && entries().length === 5);

// The server's reason is shown when it refuses.
const q = entries()[0].querySelector(".answer-question");
q.value = "x".repeat(201);
blur(q);
await wait(300);
check("refusal shown", /at most 200/.test(section.querySelector(".answers-status").textContent), section.querySelector(".answers-status").textContent);

// Saves go one at a time, so a slow earlier save can't land after a later one.
q.value = "Are you authorized to work in the EU / where are you based?";
blur(q);
await wait(300);
const realFetch = window.fetch;
let delayed = false;
window.fetch = async (url, opts) => {
  if (String(url).includes("/api/answers") && opts?.method === "PUT" && !delayed) {
    delayed = true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return realFetch(url, opts);
};
const first = entries()[0].querySelector(".answer-text");
first.value = "EU citizen";
blur(first);                                    // slow save, sent first
entries()[4].querySelector(".answer-remove").click(); // quick save, sent second
await wait(1200);
window.fetch = realFetch;
const latest = await server();
check("later save wins", latest.length === 4 && latest[0].answer === "EU citizen", JSON.stringify(latest.map((a) => a.question)));

// A failed load doesn't let an edit overwrite what's stored.
window.fetch = async (url, opts) =>
  String(url).includes("/api/answers") && !opts?.method ? new Response("{}", { status: 500 }) : realFetch(url, opts);
savedAnswers = [];
await loadSavedAnswers();
window.fetch = realFetch;
check("failed load: can't add", section.querySelector(".answers-add").disabled);
check("failed load: says so", /couldn.t load/i.test(section.querySelector(".answers-status").textContent));
check("stored answers untouched", (await server()).length === 4);

// Logging out forgets them, so the next user in this tab starts clean.
logout();
check("logout clears", savedAnswers.length === 0 && !section.querySelector(".answer-entry"));
