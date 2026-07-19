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
