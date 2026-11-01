// Email digest: a logged-in user gives an address, gets a confirmation email,
// confirms it from the link (a button, so mail scanners can't), and can
// unsubscribe from the link in every digest or stop from the page.
const input = document.getElementById("digestEmail");
const info = () => document.getElementById("digestInfo").textContent;
const sent = async () => (await fetch(RESEND_SENT)).json();
const linkIn = (email, kind) => email.text.match(new RegExp(`https?://\\S+/digest/${kind}/[a-f0-9]{32}`))?.[0];
const put = (email) => fetch("/api/digest", {
  method: "PUT", headers: { Authorization: `Bearer ${TOKENS.user}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email }),
});

check("logged out: API refuses", (await fetch("/api/digest")).status === 401);

await signIn("user");
updateAuthUI();
await wait(300);
check("logged in: section shown, off", !document.getElementById("digestSection").hidden && info() === "Off.", info());
check("bad address refused", (await put("not-an-address")).status === 400);

input.value = "jane@example.com";
document.getElementById("digestForm").requestSubmit();
await wait(400);
let emails = await sent();
check("confirmation sent", emails.length === 1 && emails[0].to === "jane@example.com", JSON.stringify(emails.map((e) => e.to)));
check("pending until confirmed", info().includes("Check jane@example.com"), info());
check("stop offered", !document.getElementById("digestStop").hidden);

const again = await put("jane@example.com");
check("resend within a minute is limited", again.status === 429, again.status);

const confirmUrl = linkIn(emails[0], "confirm");
const confirmPath = new URL(confirmUrl).pathname;
const page = await (await fetch(confirmPath)).text();
check("confirm link shows a button, doesn't confirm", page.includes(">Confirm</button>")
  && (await (await fetch("/api/digest", { headers: { Authorization: `Bearer ${TOKENS.user}` } })).json()).status === "pending");
const done = await (await fetch(confirmPath, { method: "POST" })).text();
check("confirm by POST", done.includes("Confirmed"), done.slice(0, 200));
await loadDigestInfo();
check("on after confirming", info().startsWith("On:"), info());
check("confirmed address isn't re-sent", (await put("jane@example.com")).status === 200 && (await sent()).length === 1);

// The unsubscribe link is only in digests (digest.ts, tested in
// tests/digest.test.ts); here, an unknown one and the Stop button.
const unknown = await fetch("/digest/unsubscribe/" + "0".repeat(32), { method: "POST" });
check("one-click unsubscribe of an unknown link is harmless", unknown.status === 200);
check("bad confirm link", (await fetch("/digest/confirm/" + "0".repeat(32))).status === 404);

document.getElementById("digestStop").click();
await wait(300);
check("stop turns it off", info() === "Off." && document.getElementById("digestStop").hidden, info());
const stale = await (await fetch(confirmPath)).text();
check("old confirm link expired", stale.includes("expired"));
