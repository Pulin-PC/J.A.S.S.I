// Sends one op through the stub to the paired shell and prints the answer. Dev only.
//   node dev/op.mjs screen_read
//   node dev/op.mjs screen_act '{"action":"tap","n":12}'
//   node dev/op.mjs open_app '{"id":"com.apple.textedit"}'
// screen_read prints the nodes only for the harmless test apps below, so a test never dumps
// whatever else happens to be on screen into a terminal.
const SHOW = (process.env.SHOW || "com.apple.textedit,com.apple.calculator,jassi-secure-test").split(",");
const [op, args = "{}"] = process.argv.slice(2);
const res = await fetch(`http://localhost:${process.env.PORT || 8911}/dev/op`, { method: "POST", body: JSON.stringify({ op, args: JSON.parse(args) }) });
const r = await res.json();
const d = r.data;
if (op === "list_apps" && d?.apps) {
  console.log(JSON.stringify({ ok: r.ok, partial: d.partial, count: d.apps.length, first: d.apps.slice(0, 3) }));
} else if (op === "screen_read" && d?.nodes) {
  const show = SHOW.includes(d.app.id || d.app.name);
  console.log(JSON.stringify({ ok: r.ok, app: d.app, blocked: d.blocked, nodes: d.nodes.length }));
  const find = (process.env.FIND || "").toLowerCase(); // FIND=word → only nodes whose text, hint or role has it
  const wanted = d.nodes.filter(n => !find || `${n.role} ${n.text} ${n.hint || ""}`.toLowerCase().includes(find));
  if (show) for (const n of wanted.slice(0, Number(process.env.MAX || 40))) console.log("  " + JSON.stringify(n));
  else if (d.nodes.length) console.log("  (nodes not printed: the app in front is not one of the test apps)");
} else {
  console.log(JSON.stringify(r));
}
