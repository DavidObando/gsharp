package GSharp.Repl

import SharpTui

import GSharp.Repl.Engine
import GSharp.Repl.Screens

import System
import System.Text

public class ReplHost {
  shared {
    public func Run() int32 -> Run(EmittedSessionEngine())

    public func Run(engine ISessionEngine) int32 {
      try { Console.OutputEncoding = Encoding.UTF8 }
      catch (error Exception) { }

      let root = ReplApp(engine)
      let app = App()
      root.Configure(app)
      try {
        app.Run(root)
        return 0
      } finally {
        root.CancelPendingInput()
        if let disposable = engine as IDisposable { disposable.Dispose() }
      }
    }

    public func GetVersion() string -> Program.GetVersion()
  }
}
