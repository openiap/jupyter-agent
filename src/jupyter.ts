import { spawn, execSync, ChildProcessWithoutNullStreams } from 'child_process';
const ctrossspawn = require('cross-spawn');
import { Kernel, KernelManager, ContentsManager, ServerConnection, SessionManager, Session } from "@jupyterlab/services";
import { getid } from './util';
import * as net from "net"
import * as fs from 'fs';
import * as path from "path";
import * as yaml from "js-yaml";
import * as chokidar from "chokidar";
const { createProxyMiddleware } = require('http-proxy-middleware');
import * as http from 'isomorphic-git/http/node';
import * as git from 'isomorphic-git';

export async function FindFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let srv = net.createServer();
    try {
      srv.on('error', (err) => {
        if (err.message.includes('EADDRINUSE')) {
          srv = net.createServer();
          // If preferred port is in use, listen on a random free port by specifying port 0
          srv.listen(0, () => {
            var a = srv.address();
            // @ts-ignore
            const port = a.port;
            srv.close(() => resolve(port));
          });
        } else {
          // If other error, reject the promise
          reject(err);
        }
      });

      srv.listen(preferred, () => {
        // @ts-ignore
        const port = srv.address().port;
        // Preferred port is available, use it
        srv.close(() => resolve(port));
      });
    } catch (error) {
      // If preferred port is in use, listen on a random free port by specifying port 0
      srv.listen(0, () => {
        // @ts-ignore
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    }
  });
}
export class JupyterInstance {
  constructor(private server: any, private app: any, public path: string, public port: number = 0, public token: string = "") {
    console.log('JupyterInstance created');
    process.on('SIGINT', async function () {
      console.log("Caught interrupt signal");
      try {
        await this.dispose();
        setTimeout(() => { process.exit(); }, 2000);
      } catch (error) {
      }
    });
  }
  running: boolean = false;
  autorestart: boolean = true;
  baseurl:string = 'https://demo.openiap.io/git/';

  async CheckForUpdates(login, name) {
    const dir = path.join(process.cwd(), "users", name);
    const email = login.user.email || login.user.username;
    const username = login.user.username.split("@").join("_");
    const url = `${this.baseurl}${username}/${name}`
    const author = { name: login.user.name, email }
    const headers = { 'Authorization': `Bearer ${login.jwt}` }
    try {
      const matrix = await git.statusMatrix({ fs, dir })
      const unstagedFilePaths = matrix.filter((row) => row[2] !== row[3]).map((row) => row[0]);
      if (unstagedFilePaths.length > 0) {
        const notdeleted = matrix.filter((row) => row[2] !== row[3] && row[2] > 0).map((row) => row[0]);
        const deleted = matrix.filter((row) => row[2] !== row[3] && row[2] == 0).map((row) => row[0]);
        console.log(`Committing and pushing ${unstagedFilePaths.length} changes.`);
        await Promise.all(notdeleted.map((filepath) => git.add({ fs, dir, filepath })));
        await Promise.all(deleted.map((filepath) => git.remove({ fs, dir, filepath })));
        await git.commit({ fs, dir, author, message: `Auto commit ${unstagedFilePaths.length} changes.` });
        await git.push({ fs, http, dir, url, headers });
      }
      await git.pull({ fs, http, dir, url, author, headers });
      this.changed = false;
    } catch (error) {
      console.error('Error:', error.message);
    }
    setTimeout(() => { this.CheckForUpdates(login, name); }, 10000);
  }
  async prepareAndClone(login, name) {
    const email = login.user.email || login.user.username;
    const username = login.user.username.split("@").join("_");
    const dir = path.join(process.cwd(), "users", name);
    const url = `${this.baseurl}${username}/${name}`
    const author = { name: login.user.name, email }
    const headers = { 'Authorization': `Bearer ${login.jwt}` }

    console.log("========================================================");
    console.log("User:", username + ":", login.user.name, ":", login.user.email);
    console.log("Directory:", dir);
    console.log("url:", url);
    console.log("========================================================");

    const newDir = !fs.existsSync(dir);
    const gitDirExists = fs.existsSync(path.join(dir, '.git'));

    const info = await git.getRemoteInfo({ http, url, headers });
    if (info.refs == null) {
      await git.init({ fs, dir });
      await git.branch({ fs, dir, ref: 'main', force: true });
      await git.addRemote({ fs, dir, remote: 'origin', url, force: true});
      fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n\nThis is a git repository for ${name}.\n`, { flag: 'a' });
    } else {
      if (fs.existsSync(dir)) {
        try {
          await git.pull({ fs, http, dir, url, headers, author });
        } catch (error) {
          console.log('error:', error.message, 'Deleting dir', dir)
          fs.rmSync(dir, { recursive: true })
        }
      }
      if (!fs.existsSync(dir)) {
        await git.clone({ fs, http, dir, url, headers });
      }
    }
    this.CheckForUpdates(login, name);
    console.log("========================================================");
    this.Watch();
  }
  public async GetServerList() {
    const result = await this.RunPythonProcessSync(["jupyter", "server", "list"]);
    if (result.status === 0) {
      const stdout = result.stdout.toString();
      const lines = stdout.split(/\r?\n/).filter((line: string) => line.trim() !== '');
      // remove first line
      return lines.slice(1);
    } else {
      if (result.stderr != null && result.stderr.toString() != "") {
        console.log(result.stderr.toString());
      }
      if (result.stdout != null && result.stdout.toString() != "") {
        console.log(result.stdout.toString());
      }
    }
    return [];
  }
  public async StopAllServers() {
    var list = await this.GetServerList();
    if (list.length > 0) {
      console.log(list)
      for (let i = 0; i < list.length; i++) {
        await this.StopServer(list[i]);
      }
    }
    this.running = false;
  }
  public async StopServer(line: string) {
    if (line == null || line.trim() == "") return;
    let port = line;
    if (line.indexOf(":") > -1 && line.indexOf("/") > -1) {
      const parts = line.split("::");
      if (parts.length < 2) return;
      const url = parts[0].trim();
      port = url.split(":")[2].split("/")[0];
    }
    console.log("Requesting stop server at port " + port);
    const result = await this.RunPythonProcessSync(["jupyter", "server", "stop", port]);
    if (result.status === 0) {
      const stdout = result.stdout.toString();
      const lines = stdout.split(/\r?\n/).filter((line: string) => line.trim() !== '');
      return lines;
    } else {
      if (result.stderr != null && result.stderr.toString() != "") {
        console.log(result.stderr.toString());
      }
      if (result.stdout != null && result.stdout.toString() != "") {
        console.log(result.stdout.toString());
      }
    }
  }

  public GetNotebookList() {
    const conda = this.findCondaPath();
    const result = ctrossspawn.sync(conda, ["run", "jupyter", "notebook", "list"], { stdio: 'pipe' });
    if (result.status === 0) {
      const stdout = result.stdout.toString();
      const lines = stdout.split(/\r?\n/).filter((line: string) => line.trim() !== '');
      return lines;
    } else {
      if (result.stderr != null && result.stderr.toString() != "") {
        console.log(result.stderr.toString());
      }
      if (result.stdout != null && result.stdout.toString() != "") {
        console.log(result.stdout.toString());
      }
    }
    return [];
  }
  public StopNotebook(port: string) {
    const conda = this.findCondaPath();
    const result = ctrossspawn.sync(conda, ["run", "jupyter", "notebook", "stop", port], { stdio: 'pipe' });
    if (result.status === 0) {
      const stdout = result.stdout.toString();
      const lines = stdout.split(/\r?\n/).filter((line: string) => line.trim() !== '');
      return lines;
    } else {
      if (result.stderr != null && result.stderr.toString() != "") {
        console.log(result.stderr.toString());
      }
      if (result.stdout != null && result.stdout.toString() != "") {
        console.log(result.stdout.toString());
      }
    }
    return [];
  }
  public StopAllNotebooks() {
    const conda = this.findCondaPath();
    const result = ctrossspawn.sync(conda, ["run", "jupyter", "notebook", "stop", "all"], { stdio: 'pipe' });
    if (result.status === 0) {
      const stdout = result.stdout.toString();
      const lines = stdout.split(/\r?\n/).filter((line: string) => line.trim() !== '');
      return lines;
    } else if (result.status === 1) {
      const stdout = result.stderr.toString() + result.stdout.toString();
      // get all line with - in them
      const lines = stdout.split(/\r?\n/).filter((line: string) => line.trim() !== '').filter((line: string) => line.indexOf("-") != -1);
      // return the number after - in each line
      const ports = lines.map((line: string) => line.split("-")[1].trim());
      for (var port of ports) {
        this.StopNotebook(port);
      }
    } else {
      if (result.stderr != null && result.stderr.toString() != "") {
        console.log(result.stderr.toString());
      }
      if (result.stdout != null && result.stdout.toString() != "") {
        console.log(result.stdout.toString());
      }
    }
    return [];
  }
  public findInPath(exec: string): string | null {
    try {
      let command;
      switch (process.platform) {
        case 'linux':
        case 'darwin':
          command = 'which';
          break;
        case 'win32':
          command = 'where.exe';
          break;
        default:
          throw new Error(`Unsupported platform: ${process.platform}`);
      }
      const result: any = ctrossspawn.sync(command, [exec], { stdio: 'pipe' });
      if (result.status === 0) {
        const stdout = result.stdout.toString();
        const lines = stdout.split(/\r?\n/).filter((line: string) => line.trim() !== '')
          .filter((line: string) => line.toLowerCase().indexOf("windowsapps\\python3.exe") == -1)
          .filter((line: string) => line.toLowerCase().indexOf("windowsapps\\python.exe") == -1);
        if (lines.length > 0) return lines[0]
      } else {
        if (result.stderr != null && result.stderr.toString() != "") {
          // console.log(result.stderr.toString());
        }
        if (result.stdout != null && result.stdout.toString() != "") {
          // console.log(result.stdout.toString());
        }
      }
      return "";
    } catch (error) {
      return "";
      // throw error;
    }
  }
  public findCondaPath() {
    var result = this.findInPath("conda")
    if (result == "") result = this.findInPath("micromamba")
    return result;
  }
  public async CreateTempEnvoriment() {
    var envfile = ""
    const packagepath = path.join("users", this.path);
    if (fs.existsSync(path.join(packagepath, "conda.yaml"))) envfile = "conda.yaml"
    if (fs.existsSync(path.join(packagepath, "conda.yml"))) envfile = "conda.yml"
    if (fs.existsSync(path.join(packagepath, "environment.yml"))) envfile = "environment.yml"
    if (fs.existsSync(path.join(packagepath, "environment.yaml"))) envfile = "environment.yaml"
    if (envfile == "") {
      if (fs.existsSync(packagepath) == false) {
        fs.mkdirSync(packagepath);
      }
      const condafile = `name: ${getid()}
channels:
    - conda-forge
    - defaults
dependencies:
    - jupyterlab
    - pip
    `;
      // - numpy
      // - pandas
      // - pytorch
      // - python
      fs.writeFileSync(path.join(packagepath, "conda.yaml"), condafile);
      envfile = "conda.yaml";
    }
  }
  public async condainstall(condapath: string): Promise<string> {
    await this.CreateTempEnvoriment();
    var envname = null;
    // create environment and install packages
    var envfile = ""
    const packagepath = path.join("users", this.path);
    if (fs.existsSync(path.join(packagepath, "conda.yaml"))) envfile = "conda.yaml"
    if (fs.existsSync(path.join(packagepath, "conda.yml"))) envfile = "conda.yml"
    if (fs.existsSync(path.join(packagepath, "environment.yml"))) envfile = "environment.yml"
    if (fs.existsSync(path.join(packagepath, "environment.yaml"))) envfile = "environment.yaml"
    if (envfile != "") {
      let fileContents = fs.readFileSync(path.join(packagepath, envfile), 'utf8');

      const data: any = yaml.load(fileContents);
      if (data != null) envname = data.name;
      if (envname == null || envname == "") {
        data.name = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        envname = data.name
        console.error("No name found in conda environment file, auto generated name: " + envname);
        fileContents = yaml.dump(data)
        fs.writeFileSync(path.join(packagepath, envfile), fileContents);
      }
    }
    if (envname == null) return envname;
    if (!fs.existsSync(path.join(packagepath, envfile))) return envname;
    let param = ["env", "create", "-f", path.join(packagepath, envfile)]
    if (condapath.indexOf("micromamba") != -1) {
      param = ["env", "create", "-y", "-f", path.join(packagepath, envfile)]
    }
    let exists = false;
    if (fs.existsSync(process.env.HOME + "/.conda/environments.txt")) {
      const fileContents = fs.readFileSync(process.env.HOME + "/.conda/environments.txt", 'utf8').split("\n")
      for (let i = 0; i < fileContents.length; i++) {
        if (fs.existsSync(fileContents[i])) {
          if (path.basename(fileContents[i]) == envname) {
            exists = true;
            break;
          }
        }
      }
    }
    if (!exists) {
      if (fs.existsSync("/opt/conda/envs/")) {
        if (fs.existsSync("/opt/conda/envs/" + envname)) {
          exists = true;
        }
      }
    }
    if (exists) {
      if (fs.existsSync(path.join(packagepath, "conda.yaml.done"))) return envname;
      param = ["env", "update", "-f", path.join(packagepath, envfile)];
      if (condapath.indexOf("micromamba") != -1) {
        param = ["update", "-y", "-f", path.join(packagepath, envfile)];
      }
      console.log(condapath, param.join(" "));
      const result = ctrossspawn.sync(condapath, param, { stdio: 'inherit' });
      if (result.status == 0) {
        fs.writeFileSync(path.join(packagepath, "conda.yaml.done"), "Delete me to, force reinstalling packages doing next run");
      } else {
        console.error("Error running: " + condapath + " " + param.join(" "));
      }
      return envname;;
    } else {

    }

    console.log(condapath, param.join(" "));
    const result = ctrossspawn.sync(condapath, param, { stdio: 'inherit' });
    if (result.status == 0) {
      fs.writeFileSync(path.join(packagepath, "conda.yaml.done"), "Delete me to, force reinstalling packages doing next run");
    } else {
      console.error("Error running: " + condapath + " " + param.join(" "));
    }
    return envname;
  }
  public async setupConda() {
    const conda = this.findCondaPath();
    await this.condainstall(conda)
  }
  async RunPythonProcessSync(params: string[]) {
    await this.CreateTempEnvoriment();
    const conda = this.findCondaPath();
    const condaname = await this.condainstall(conda);
    const result = ctrossspawn.sync(conda, ['run', '-n', condaname, ...params], { stdio: 'pipe' });
    return result;
  }
  async RunPythonProcessAsync(params: string[]) {
    const conda = this.findCondaPath();
    const condaname = await this.condainstall(conda);
    const packagepath = path.join("users", this.path);
    const result = spawn(conda, [
      'run', '-n', condaname, ...params],
      { cwd: packagepath });
    console.log(conda, 'run', '-n', condaname, params.join(" "));
    return result;
  }
  jupyterprocess: ChildProcessWithoutNullStreams
  proxy: any;
  wsupgrader: any;
  async LaunchJupyterProcess() {
    if (this.port == null || (this.port as any) == "" || this.port < 10) {
      this.port = await FindFreePort(0);
    }
    // if(token == '' || token == null) {
    //     this.token = getid();
    // }
    const packagepath = path.join("users", this.path);
    if (fs.existsSync(packagepath) == false) {
      fs.mkdirSync(packagepath);
    }
    // const conda = this.findCondaPath();
    // const condaname = await this.condainstall(path, conda);

    const disableannouncement = await this.RunPythonProcessAsync(['jupyter', 'labextension', 'disable', '@jupyterlab/apputils-extension:announcements'])

    const params = ['jupyter', 'lab', '--ip', '0.0.0.0', '--port', this.port.toString(), '--no-browser',
      '--IdentityProvider.token=' + this.token, '--NotebookApp.allow_origin="*"',
      '--NotebookApp.disable_check_xsrf=True',
      '--NotebookApp.base_url=/user/' + this.path];
    // const jupyter = spawn(conda, [
    //     'run', '-n', condaname, ...params], 
    // { cwd: path });
    // console.log(params.join(" "));
    this.jupyterprocess = await this.RunPythonProcessAsync(params)
    this.running = true;
    this.jupyterprocess.stdout.on('data', (data) => {
      console.log(`${data}`);
    });
    this.jupyterprocess.stderr.on('data', (data) => {
      console.log(`${data}`);
    });
    const onClose = (code) => {
      this.running = false;
      console.log(`child process exited with code ${code}`);
      if (this.autorestart) {
        setTimeout(async () => {
          try {
            await this.LaunchJupyterProcess();
          } catch (error) {
            console.error(error);
          }
        }, 1000);
      }
    }
    this.jupyterprocess.on('close', onClose.bind(this));
    if(this.proxy == null) {
      this.proxy = createProxyMiddleware({
        target: 'http://127.0.0.1:' + this.port + '/',
        changeOrigin: true,
        ws: false,
      });
    }
    if(this.wsupgrader == null) {
      const upgrade = (req, socket, head) => {
        if (req.url.indexOf('/user/' + this.path) === 0) {
          console.log('proxy upgrade', req.url, '/user/' + this.path)
          this.proxy.upgrade(req, socket, head);
        } else {
          // console.log('ignoring', req.url, '/user/' + this.path)
        }
      }
      this.wsupgrader = upgrade.bind(this);
    }
    var exists = this.app._router?.stack?.find((layer) => layer.handle === this.proxy);
    if(exists == null) {
      this.app.use('/user/' + this.path + '*', this.proxy);
      this.server.on('upgrade', this.wsupgrader);
    }
    return '/user/' + this.path + '/lab/?token=' + this.token;
  }
  public async CreateKernel(host: string, port: number, token: string, path: string, kernel: string): Promise<Kernel.IKernelConnection> {
    try {
      var serverSettings = ServerConnection.makeSettings({
        baseUrl: 'http://' + host + ':' + port + '/',
        wsUrl: 'ws://' + host + ':' + port + '/',
        token: token
      });
      if (this.path != null && this.path != "") {
        serverSettings = ServerConnection.makeSettings({
          baseUrl: 'http://' + host + ':' + port + '/user/' + this.path + '/',
          wsUrl: 'ws://' + host + ':' + port + '/user/' + this.path + '/',
          token: token
        });
      }
      const kernelManager = new KernelManager({ serverSettings });
      return await kernelManager.startNew({ name: kernel });
    } catch (error) {
      throw new Error(error.message);
    }
  }
  public async CreateSession(host: string, port: number, token: string, path: string, filename: string): Promise<Session.ISessionConnection> {
    try {
      var serverSettings = ServerConnection.makeSettings({
        baseUrl: 'http://' + host + ':' + port + '/',
        wsUrl: 'ws://' + host + ':' + port + '/',
        token: token
      });
      if (this.path != null && this.path != "") {
        serverSettings = ServerConnection.makeSettings({
          baseUrl: 'http://' + host + ':' + port + '/user/' + this.path + '/',
          wsUrl: 'ws://' + host + ':' + port + '/user/' + this.path + '/',
          token: token
        });
      }
      const contents = new ContentsManager({ serverSettings });
      const content = await contents.get(filename);
      const kernelManager = new KernelManager({ serverSettings });
      const sessionManager = new SessionManager({ serverSettings, kernelManager });
      return await sessionManager.startNew({ kernel: { name: content.content.metadata.kernel }, name: 'foo-session', type: 'notebook', path: filename });
    } catch (error) {
      throw new Error(error.message);
    }
  }
  run() {
    console.log('JupyterInstance running');
  }
  changed: boolean = false;
  watcher: chokidar.FSWatcher;
  Watch() {
    const packagepath = path.join("users", this.path);
    this.watcher = chokidar.watch(packagepath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: false,
      depth: Infinity, // To ensure recursive watch
    });
    let ready = false;
    const onchange = (event, path) => {
      if(!ready) return;
      var w = this.watcher;
      console.log(`File ${path} has been ${event}`)
      this.changed = true;
    }
    this.watcher
      .on('add', path => onchange('add', path))
      .on('change', path => onchange('change', path))
      .on('unlink', path => onchange('unlink', path))
      .on('addDir', path => onchange('addDir', path))
      .on('unlinkDir', path => onchange('unlinkDir', path))
      .on('error', error => console.log(`Watcher error: ${error}`))
      .on('ready', () => { ready = true; console.log('Initial scan complete. Ready for changes') } )
      .on('raw', (event, path, details) => {
        // console.log('Raw event info:', event, path, details);
      });
  }
  async dispose() {
    this.autorestart = false;
    if (this.watcher != null) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.jupyterprocess != null) {
      this.jupyterprocess.removeAllListeners();
      try {
        this.jupyterprocess.kill();
      } catch (error) {
      }
      this.jupyterprocess = null;
    }
    if (this.running) {
      if (this.port > 1) await this.StopServer(this.port.toString());
      console.log("done.")
    }
  }
}