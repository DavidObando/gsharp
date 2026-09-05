package HotReloadApp

import HotReloadLib
import System
import System.Threading

func LocalValue() int32 {
    return 1
}

var iteration int32 = 0
Console.WriteLine("pid=" + Environment.ProcessId.ToString())
Console.WriteLine("modifiable=" + Environment.GetEnvironmentVariable("DOTNET_MODIFIABLE_ASSEMBLIES"))
while iteration < 6000 {
    Console
        .WriteLine(
        "values=" +
            LocalValue()
            .ToString() +
            "," +
            Values
            .Current()
            .ToString() +
            "," +
            GeneratedLike
            .Current()
            .ToString()
    )
    Thread.Sleep(100)
    iteration++
}
