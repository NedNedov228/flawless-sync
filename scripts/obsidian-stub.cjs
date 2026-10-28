// Minimal stand-in for the `obsidian` module so unit tests can run under Node.
// Only the surface the sync engine touches is implemented.

class TAbstractFile {
  constructor() {
    this.path = "";
  }
}

class TFile extends TAbstractFile {
  constructor() {
    super();
    this.stat = { ctime: 0, mtime: 0, size: 0 };
    this.basename = "";
    this.extension = "";
  }
}

class TFolder extends TAbstractFile {
  constructor() {
    super();
    this.children = [];
  }

  isRoot() {
    return this.path === "/";
  }
}

const requestUrl = async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) });

module.exports = { TAbstractFile, TFile, TFolder, requestUrl };
