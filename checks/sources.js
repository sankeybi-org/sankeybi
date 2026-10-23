// Source text of the rendering modules, for the few checks that assert on it.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

/** Every src/render*.ts file, concatenated. */
function renderSource() {
    return fs.readdirSync(SRC)
        .filter(f => /^render.*\.ts$/.test(f))
        .sort()
        .map(f => fs.readFileSync(path.join(SRC, f), "utf8"))
        .join("\n");
}

/** Every src/settings*.ts file, concatenated. */
function settingsSource() {
    return fs.readdirSync(SRC)
        .filter(f => /^settings.*\.ts$/.test(f))
        .sort()
        .map(f => fs.readFileSync(path.join(SRC, f), "utf8"))
        .join("\n");
}

module.exports = { renderSource, settingsSource };
