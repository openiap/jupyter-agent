import { openiap } from "@openiap/nodeapi";
import * as services from '@jupyterlab/services';
import { KernelManager, ServerConnection, SessionManager } from "@jupyterlab/services";
import { FindFreePort, JupyterInstance } from "./jupyter";




// Code to execute
const pycellCode1 = [
  'from IPython.display import HTML',
  'HTML("<h1>Hello, world!</h1>")'
].join('\n');
const cellCode1 = 'console.log("Hello, Jupyter Notebook 1!", (new Date()).toISOString() );';
const cellCode2 = 'throw new Error("This is an error!");';
const cellCode3 = 'console.log("Hello, Jupyter Notebook 2!", (new Date()).toISOString() );';
const notebookContent = {
  content: {
    nbformat: 4,
    nbformat_minor: 4,
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: cellCode1
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: cellCode2
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: cellCode3
      }
    ],
    metadata: {
      kernel: "tslab",
      kernelspec: {
        display_name: "TypeScript",
        language: "typescript",
        name: "tslab"
      }
    }
  },
  // format: 'json',
  type: 'notebook'
};

// Server settings configuration
const serverSettings = ServerConnection.makeSettings({
  baseUrl: 'http://10.0.0.130:8888/', // Jupyter server URL
  wsUrl: 'ws://10.0.0.130:8888/', // WebSocket URL
  token: 'f9a3bd4e9f2c3be01cd629154cfb224c2703181e050254b5' // Authentication token
});

async function NewSession(filename: string, sessionManager: SessionManager) {
  const contents = new services.ContentsManager({ serverSettings });
  const content = await contents.get('foo.ipynb');
  const session = await sessionManager.startNew({ kernel: { name: content.content.metadata.kernel }, name: 'foo-session', type: 'notebook', path: 'foo.ipynb' });
  return { session, contents, content };
}
async function executeCell(idx: number, contents: services.ContentsManager, content: services.Contents.IModel, session: services.Session.ISessionConnection) {
  const Cell = notebookContent.content.cells[idx];
  let hadError = false;
  if (Cell.cell_type === 'code') {
    let codeToExecute = Cell.source;
    if (Array.isArray(codeToExecute)) {
      codeToExecute = codeToExecute.join('\n');
    }

    const future = session.kernel.requestExecute({ code: codeToExecute });
    Cell.outputs = [];

    future.onIOPub = (msg) => {
      const content: any = msg.content;
      console.log(content); // Log messages from the kernel
      if (content.text) {
        Cell.outputs = [{
          output_type: 'stream',
          name: content.name, // 'stdout',
          text: content.text,
        }];
        if (content.name === 'stderr') {
          hadError = true;
        }
      }
    };

    // Wait for the execution to complete
    await future.done;
    await contents.save('foo.ipynb', notebookContent);
  }
  return !hadError;
}
async function executeFirstCell(sessionManager: SessionManager) {
  try {
    const { session, contents, content } = await NewSession('foo.ipynb', sessionManager);
    await executeCell(0, contents, content, session);
    await session.shutdown();
    session.dispose();
  } catch (error) {
    console.error('Error executing the first cell:', error);
  }
}
async function executeAllCell(sessionManager: SessionManager) {
  try {
    const { session, contents, content } = await NewSession('foo.ipynb', sessionManager);
    for (let i = 0; i < notebookContent.content.cells.length; i++) {
      if (!await executeCell(i, contents, content, session)) {
        console.error('Error executing cell:', i, notebookContent.content.cells[i].outputs[0].text);
        break;
      }
    }
    await session.shutdown();
    session.dispose();
  } catch (error) {
    console.error('Error executing the first cell:', error.message);
  }
}


let j: JupyterInstance

async function main() {
  let port = await FindFreePort(3000);
  const client = new openiap();
  const express = require('express');
  const app = express();
  app.listen(port);
  console.log("Listening on http://localhost:" + port);


  await client.connect();
  console.log("get token")
  const login = await client.Signin({ validateonly: true, longtoken: true });

  const reponame = "allan";


  j = new JupyterInstance(app, reponame, port + 1);
  try {
    await j.prepareAndClone(login, reponame);
    await j.StopAllServers();
    const url1 = await j.LaunchJupyterProcess();
    console.log("***************************************")
    console.log('http://localhost:' + port + url1);
    console.log("***************************************")
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }


  // await new Promise(res => setTimeout(res, 2000));

  // console.log("macos");
  // // await JupyterInstance.CreateKernel("10.0.0.130", 8888, "f9a3bd4e9f2c3be01cd629154cfb224c2703181e050254b5", "", "python");
  // await JupyterInstance.CreateSession("10.0.0.130", 8888, "f9a3bd4e9f2c3be01cd629154cfb224c2703181e050254b5", "", "foo.ipynb");
  // console.log("linux");
  // for(let i = 0; i < 10; i++) {
  //   try {
  //     // await JupyterInstance.CreateKernel("127.0.0.1", 35543, "12345", "allan", "python");
  //     await JupyterInstance.CreateSession("127.0.0.1", 35543, "12345", "allan", "foo.ipynb");
  //     break;
  //   } catch (error) {
  //     await new Promise(res => setTimeout(res, 500));
  //     console.error(error.message);
  //   }
  // }
  console.log("done.");

  // const kernelManager = new KernelManager({ serverSettings });
  // const sessionManager = new SessionManager({ serverSettings, kernelManager });
  // const session = await NewSession('foo.ipynb', sessionManager);

  // try {
  //   // save file
  //   const contents = new services.ContentsManager({ serverSettings });
  //   await contents.save('foo.ipynb', notebookContent)

  //   // await executeFirstCell(sessionManager);
  //   await executeAllCell(sessionManager);
  // } catch (err) {
  //   console.error('Failed to start session or execute code:', err);
  // } finally {
  //   // Shut down the session manager
  //   if(sessionManager != null && !sessionManager.isDisposed) {
  //     await sessionManager.shutdownAll();
  //     sessionManager?.dispose();
  //   }
  //   if(kernelManager != null && !kernelManager.isDisposed) {
  //     await kernelManager.shutdownAll();
  //     kernelManager?.dispose();
  //   }
  // }

}
main();

process.on('SIGINT', async function () {
  console.log("Caught interrupt signal");
  await j.dispose();
  process.exit();
});