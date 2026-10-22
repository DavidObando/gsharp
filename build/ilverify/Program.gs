import GSharp.Compiler.Tests
import System

// Exit zero only when every diagnostic is explained by a verified ILVerify defect.

return if args.Length == 1 && IlVerifyFalsePositives.OnlyKnown(args[0], Console.In.ReadToEnd()) {
    0
} else {
    1
}
