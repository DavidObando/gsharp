package VsAcceptance.Console

import System
import System.Threading
import Newtonsoft.Json
import VsAcceptance.Library

func ParseExpectedException() int32 {
    return Int32.Parse("expected exception") // BREAKPOINT:exception
}

func StepTarget(value int32) int32 {
    return value + 1
}

var input = 20
var greeter = Greeter("debugger")
Console.WriteLine(greeter.Greet())
var result = input + 22
Console.WriteLine(JsonConvert.SerializeObject(result)) // BREAKPOINT:console-locals
var stepped = StepTarget(result) // BREAKPOINT:step-into
Console.WriteLine(stepped)

try {
    var parsed = ParseExpectedException()
} catch (e FormatException) {
    Console.WriteLine(e.Message) // BREAKPOINT:catch-handler
}

Thread.Sleep(1000)
