import { spawn } from "child_process";

const child = spawn("node", ["packages/coding-agent/dist/cli.js", "-ne", "-ns", "-np"], {
    stdio: ["pipe", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", data => {
    output += data.toString();
    if (output.includes("Working")) {
        console.log("Got working prompt.");
    }
});
child.stderr.on("data", data => console.error("ERR:", data.toString()));

setTimeout(() => {
    console.log("Sending prompt");
    child.stdin.write("Hello\n");
}, 2000);

setTimeout(() => {
    console.log(JSON.stringify(output));
    child.kill();
}, 5000);
