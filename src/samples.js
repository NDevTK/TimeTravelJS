// Sample programs for the picker. Each exercises different debugger features.

export const SAMPLES = [
  {
    id: "bubble-sort",
    name: "Bubble sort (loops & arrays)",
    code: `// Scrub the timeline and watch the array reorder itself.
function bubbleSort(arr) {
  let swaps = 0;
  for (let pass = 0; pass < arr.length - 1; pass++) {
    let swapped = false;
    for (let i = 0; i < arr.length - 1 - pass; i++) {
      if (arr[i] > arr[i + 1]) {
        const tmp = arr[i];
        arr[i] = arr[i + 1];
        arr[i + 1] = tmp;
        swaps++;
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return swaps;
}

const numbers = [23, 5, 42, 8, 16, 4, 15];
const swaps = bubbleSort(numbers);
console.log("sorted:", numbers.join(", "));
console.log("swaps:", swaps);
`,
  },
  {
    id: "fibonacci",
    name: "Fibonacci (recursion & call stack)",
    code: `// Step into the recursion and watch the call stack grow and shrink.
function fib(n) {
  if (n <= 1) {
    return n;
  }
  const a = fib(n - 1);
  const b = fib(n - 2);
  return a + b;
}

const results = [];
for (let i = 0; i <= 8; i++) {
  results.push(fib(i));
}
console.log("fib(0..8) =", results.join(", "));
`,
  },
  {
    id: "closures",
    name: "Closures (captured state)",
    code: `// Each counter closes over its own hidden state — rewind to see it change.
function makeCounter(name, step) {
  let count = 0;
  return function increment() {
    count += step;
    console.log(name, "is now", count);
    return count;
  };
}

const slow = makeCounter("slow", 1);
const fast = makeCounter("fast", 10);

for (let round = 1; round <= 3; round++) {
  slow();
  fast();
}
const total = slow() + fast();
console.log("total:", total);
`,
  },
  {
    id: "bank",
    name: "Classes (methods & state)",
    code: `// Object state over time: find the exact moment the balance went negative.
class Account {
  constructor(owner, balance) {
    this.owner = owner;
    this.balance = balance;
    this.history = [];
  }
  apply(amount, reason) {
    this.balance += amount;
    this.history.push(reason + ": " + amount);
    return this.balance;
  }
}

const acct = new Account("ada", 100);
const charges = [
  [-30, "coffee gear"],
  [-45, "books"],
  [+60, "refund"],
  [-95, "mechanical keyboard"],
  [+20, "found in coat pocket"],
];
for (const [amount, reason] of charges) {
  const after = acct.apply(amount, reason);
  console.log(reason, "->", after);
}
console.log("final balance:", acct.balance);
`,
  },
  {
    id: "timers",
    name: "Virtual timers & deterministic time",
    code: `// setTimeout runs on a virtual clock after the main script — every callback
// step is its own resumable snapshot, like everything else.
console.log("t =", Date.now(), "(virtual epoch)");

let sequence = [];
setTimeout(() => {
  sequence.push("slow");
  console.log("slow timer, t =", Date.now());
}, 300);

setTimeout(() => {
  sequence.push("fast");
  console.log("fast timer, t =", Date.now());
  setTimeout(() => {
    sequence.push("nested");
    console.log("nested timer, t =", Date.now());
  }, 50);
}, 100);

console.log("main script done, rolled dice:", Math.floor(Math.random() * 6) + 1);
`,
  },
  {
    id: "website",
    name: "Website (URL params, storage, feature flags)",
    url: "https://news.example/?user=ada",
    html: `<style>
  body { background: white; color: #223; }
  body.dark { background: #10141d; color: #dde; }
  body.solar { background: #fdf6e3; color: #586e75; }
  .hidden { display: none; }
  #status { font-size: 12px; color: #789; }
</style>
<h1 id="title">the daily paradox</h1>
<section id="beta-panel" class="hidden"><p>🧪 beta tools</p></section>
<p id="status"></p>
`,
    code: `// A tiny "site": its configuration comes from the URL, localStorage
// and postMessage. Try the probe
//   !document.getElementById("beta-panel").classList.contains("hidden")
// then press "?⑂ inputs" — the debugger probes every input the page
// consulted with canary values and LEARNS real ones by running code
// branches: each alternate run's own comparisons teach the next
// candidate ("theme" === "solar", data === "debug:on"), and inputs
// whose logic never ran as-recorded are probed first.
const params = new URLSearchParams(location.search);

// dormant logic: no message ever arrives on this page as recorded — the
// input search wakes the handler and learns its payload from the
// handler's own comparison (try the probe
//   document.getElementById("title").classList.contains("debug") )
window.addEventListener("message", (e) => {
  if (e.data === "debug:on") {
    document.getElementById("title").classList.add("debug");
  }
});

// colour preference: ?theme=... wins, else the stored preference
const saved = localStorage.getItem("theme");
const theme = params.get("theme") || saved || "light";
if (theme === "dark" || theme === "solar") {
  document.body.classList.add(theme);
  localStorage.setItem("theme", theme);
}

// feature flag: ?beta=1 reveals the hidden panel
if (params.get("beta") === "1") {
  document.getElementById("beta-panel").classList.remove("hidden");
}

const who = params.get("user") || "anonymous";
document.getElementById("status").textContent =
  who + " · theme " + theme + (params.get("beta") === "1" ? " · beta on" : "");
console.log(location.href);
console.log("theme:", theme, "| beta:", params.get("beta"), "| stored:", localStorage.getItem("theme"));
`,
  },
  {
    id: "dom",
    name: "DOM + CSS (document time travel)",
    html: `<style>
  li { color: #345; }
  li.done { color: #9a9; }
</style>
<h1 id="title">todos</h1>
<ul id="list"></ul>
<p id="status">empty</p>
`,
    code: `// The document lives INSIDE the machine: scrub the timeline and watch
// the preview panel replay every mutation, style change, and event.
const list = document.getElementById("list");
const status = document.getElementById("status");

function addTodo(text) {
  const li = document.createElement("li");
  li.textContent = text;
  li.addEventListener("toggle", () => {
    li.classList.toggle("done");
    li.style.textDecoration = li.matches(".done") ? "line-through" : "";
  });
  list.appendChild(li);
  status.textContent = list.children.length + " item(s)";
  return li;
}

const todos = ["invent time machine", "test time machine", "profit"];
const items = todos.map(addTodo);

// events dispatch through capture/target/bubble like a real DOM
items[1].dispatchEvent(new Event("toggle"));
items[0].dispatchEvent(new Event("toggle"));
items[0].dispatchEvent(new Event("toggle")); // undo the first one

const done = document.querySelectorAll("li.done").length;
status.textContent = done + " of " + items.length + " done";
console.log("done item:", document.querySelector("li.done"));
console.log("computed color:", getComputedStyle(items[1]).color);
`,
  },
  {
    id: "crash",
    name: "Debug a crash (travel back from an error)",
    code: `// This program crashes. Jump to the end, then step BACKWARD to find out
// why item.price is undefined when the crash happens.
const catalog = [
  { name: "widget", price: 9.5 },
  { name: "gadget", price: 12.0 },
  { name: "doohickey" },
  { name: "gizmo", price: 4.25 },
];

function priceWithTax(item) {
  const base = item.price.toFixed(2); // throws when price is missing
  return (Number(base) * 1.2).toFixed(2);
}

let total = 0;
for (const item of catalog) {
  const price = priceWithTax(item);
  console.log(item.name, "costs", price);
  total += Number(price);
}
console.log("total:", total.toFixed(2));
`,
  },
]
