/* eslint-disable no-await-in-loop */

import cp from "child_process";
import { $, nothrow, ProcessOutput } from "zx";
import Conf from "conf";
import onDeath from "death";

// wow esm support in node works GREAT in 2021, thanks for requiring its usage zx
// before you ask: no, apparently i can't just do "import { default as SysTray }".
// this might be an issue with systray2 since apparently this is supposed to be
// supported and "just work". but to be totally honest i do not have the time or
// patience to mess around more than i already have
import uhh from "systray2";
const SysTray = (uhh as any).default as typeof import("systray2").default;

const NULL_SINK_NAME = "FleuveNullSink";
const NULL_SINK_HUMAN_NAME = "Fleuve Null Sink";
const COMBINED_SINK_NAME = "FleuveCombinedSink";
const COMBINED_SINK_HUMAN_NAME = "Fleuve Combined Sink";

let nullSinkModNum: number | null = null;
let combinedSinkModNum: number | null = null;
let micLoopbackModNum: number | null = null;
let audibleLoopbackModNum: number | null = null;

const conf = new Conf({
  schema: {
    micLoopbackEnabled: { type: "boolean", default: false },
    audibleLoopbackEnabled: { type: "boolean", default: false },
  },
});

async function unwrap(p: Promise<ProcessOutput>): Promise<number> {
  const output = await p;
  const res = parseInt(String(output));
  if (isNaN(res)) {
    throw new Error(`Unexpected NaN result unwrapping command!`);
  }
  return res;
}

async function cleanup() {
  if (nullSinkModNum !== null) {
    await $`pactl unload-module ${nullSinkModNum}`;
  }

  if (combinedSinkModNum !== null) {
    await $`pactl unload-module ${combinedSinkModNum}`;
  }

  if (audibleLoopbackModNum !== null) {
    await $`pactl unload-module ${audibleLoopbackModNum}`;
  }

  if (micLoopbackModNum !== null) {
    await $`pactl unload-module ${micLoopbackModNum}`;
  }

  // there may be other existing sinks if we failed to clean up last time somehow
  const existingSinks = String(
    await nothrow(
      $`pactl list short modules`.pipe($`awk '/Fleuve/ {print $1}'`)
    )
  )
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (existingSinks.length > 0) {
    for (const sink of existingSinks) {
      await $`pactl unload-module ${sink}`;
    }
  }
}

void (async () => {
  let cleanupAttempted = false;

  process.on("beforeExit", () => {
    if (!cleanupAttempted) {
      console.log("attempting cleanup!");
      // only attempt once even if cleanup is not successful
      cleanupAttempted = true;
      void cleanup();
    }
  });

  onDeath({ debug: true })((signal) => {
    console.log(`caught signal ${signal}, cleaning up...`);
    void cleanup();
  });

  await cleanup();

  // use identity function as quote for setting cleaner device descriptions.
  const defaultQuote = $.quote;
  $.quote = (s: string) => s;

  nullSinkModNum = await unwrap(
    $`pactl load-module module-null-sink sink_name=${NULL_SINK_NAME}`
  );
  await $`pacmd "update-sink-proplist ${NULL_SINK_NAME} device.description=\\"${NULL_SINK_HUMAN_NAME}\\""`;
  await $`pacmd "update-source-proplist ${NULL_SINK_NAME}.monitor device.description=\\"Monitor of ${NULL_SINK_HUMAN_NAME}\\""`;

  const outputName = await $`pactl list short sinks`
    .pipe($`grep alsa_output.pci`)
    .pipe($`awk '{print $2}'`);

  combinedSinkModNum = await unwrap(
    $`pactl load-module module-combine-sink slaves="${NULL_SINK_NAME},${outputName}" sink_name=${COMBINED_SINK_NAME}`
  );
  await $`pacmd "update-sink-proplist ${COMBINED_SINK_NAME} device.description=\\"${COMBINED_SINK_HUMAN_NAME}\\""`;
  await $`pacmd "update-source-proplist ${COMBINED_SINK_NAME}.monitor device.description=\\"Monitor of ${COMBINED_SINK_HUMAN_NAME}\\""`;

  // restore it!
  $.quote = defaultQuote;

  if (conf.get("micLoopbackEnabled")) {
    micLoopbackModNum = await unwrap(
      $`pactl load-module module-loopback latency_msec=1 sink=${NULL_SINK_NAME}`
    );
  }

  if (conf.get("audibleLoopbackEnabled")) {
    audibleLoopbackModNum = await unwrap(
      $`pactl load-module module-loopback latency_msec=1 sink=${COMBINED_SINK_NAME}`
    );
  }

  const micLoopback = {
    title: "Mic Loopback",
    checked: micLoopbackModNum !== null,
    click: async () => {
      if (micLoopbackModNum === null) {
        micLoopbackModNum = await unwrap(
          $`pactl load-module module-loopback latency_msec=1 sink=${NULL_SINK_NAME}`
        );
        conf.set("micLoopbackEnabled", true);
      } else {
        await $`pactl unload-module ${micLoopbackModNum}`;
        micLoopbackModNum = null;
        conf.set("micLoopbackEnabled", false);
      }

      micLoopback.checked = micLoopbackModNum !== null;
      void systray.sendAction({
        type: "update-item",
        item: micLoopback,
      });
    },
  };

  const audibleLoopback = {
    title: "Audible Loopback",
    checked: audibleLoopbackModNum !== null,
    click: async () => {
      if (audibleLoopbackModNum === null) {
        audibleLoopbackModNum = await unwrap(
          $`pactl load-module module-loopback latency_msec=1 sink=${COMBINED_SINK_NAME}`
        );
        conf.set("audibleLoopbackEnabled", true);
      } else {
        await $`pactl unload-module ${audibleLoopbackModNum}`;
        audibleLoopbackModNum = null;
        conf.set("audibleLoopbackEnabled", false);
      }

      audibleLoopback.checked = audibleLoopbackModNum !== null;
      void systray.sendAction({
        type: "update-item",
        item: audibleLoopback,
      });
    },
  };

  const systray = new SysTray({
    menu: {
      icon: "./icon.png",
      title: "",
      tooltip: "",
      items: [
        micLoopback,
        audibleLoopback,
        SysTray.separator,
        {
          title: "Volume Control",
          click: async () => {
            const pavu = cp.spawn("pavucontrol", {
              detached: true,
              stdio: "ignore",
            });
            pavu.unref();
          },
        },
        SysTray.separator,
        {
          title: "Exit",
          click: () => {
            void systray.kill(false);
          },
        },
      ],
    },
  });

  void systray.onClick((action) => {
    if (action.item.click != null) {
      action.item.click();
    }
  });

  void systray.ready().then(() => {
    console.log("systray started!");
  });
})();
