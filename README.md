# Toadman Code Assist

This is a fork of Fatshark's code assist for use with Toadman's tools.

Integrated the source from the vscode-lua extension https://github.com/trixnz/vscode-lua as a starting point to integrate the linter more deeply with the Toadman engine. Thank you trixnz 🙏

## Install
Available on the Visual Studio Code Marketplace: https://marketplace.visualstudio.com/items?itemName=Toadman.toadman-code-assist

Alternatively, if you're developing it you can also clone the repo into `%UserProfile%/.vscode/extensions`.

Make sure to define the toolchain path:
![Demo](https://raw.githubusercontent.com/catdawg/vscode-fs-code-assist/master/resources/settings.gif)

To launch the game with the debugger attached, you need to setup your launch.json. Here's how:
![Demo](https://raw.githubusercontent.com/catdawg/vscode-fs-code-assist/master/resources/debug.gif)

In order for the linter to work, make sure that luacheck (https://github.com/mpeterv/luacheck) is available in the PATH. Or specify the path in the settings.
![Demo](https://raw.githubusercontent.com/catdawg/vscode-fs-code-assist/master/resources/luacheck.gif)


## Features
+ **Enhanced debugger:**
  + Attaches in <100ms instead of taking ~10 seconds (x100 fold improvement).
  + Execute Lua in the current lexical scope via the Debug Console.
  + Basic auto-complete in the debug console.
  + Expandable tree-view for table values.
+ **Lua language features support:**
  + _Go to Definition_ (<kbd>F12</kbd>)
  + _Go to Symbol in Workspace_ (<kbd>Ctrl</kbd>+<kbd>T</kbd>)
  + _Go to Symbol in Editor_ (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>)
  + Dim code inside feature flags.
  + Color picker for color tables (eg, `{255,70,130,180}`).
  + Preview texture assets by hovering them.
  + (Basic) auto-completion on `self` methods.
+ **Other features:**
  + Recompile & refresh sources from within VSCode.
  + View console output (both compiler/games) within VSCode.
  + Clickable error links in the console output.

## License
See the [LICENSE](./LICENSE.txt) file.
