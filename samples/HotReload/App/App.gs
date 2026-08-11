package HotReloadApp

import System
import System.Threading
import HotReloadLib

func LocalValue() int32 {
    return 1
}

var iteration int32 = 0
Console.WriteLine("pid=" + Environment.ProcessId.ToString())
while iteration < 6000 {
    Console.WriteLine(
        "values=" +
        LocalValue().ToString() + "," +
        Values.Current().ToString() + "," +
        GeneratedLike.Current().ToString())
    Thread.Sleep(100)
    iteration++
}
