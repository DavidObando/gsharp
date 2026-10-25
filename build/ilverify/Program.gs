import GSharp.Compiler.Tests
import System

// Exit zero only when every diagnostic is explained by a verified ILVerify defect.

if args.Length != 1 && (args.Length != 2 || args[1] != "--report") {
    return 1
}
let stdout = Console.In.ReadToEnd()
if args.Length == 2 || stdout.Contains("[ReturnPtrToStack]", StringComparison.Ordinal) {
    Console.WriteLine("raw verifier stdout:")
    Console.WriteLine(stdout)
    Console.Write(IlVerifyFalsePositives.Report(args[0], stdout))
}
return if IlVerifyFalsePositives.OnlyKnown(args[0], stdout, allowFilterInFinally: false) {
    0
} else {
    1
}
