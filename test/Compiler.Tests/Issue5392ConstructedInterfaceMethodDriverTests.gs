package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import Xunit

class Issue5392ConstructedInterfaceMethodDriverTests {
    @Fact
    func NestedDefaultBody_CallsConstructedInheritedMethod() {
        const source = `interface IBox[T] { func Echo(item T) T { return item } }
class Outer {
    interface Nested : IBox[int32] {
        func Read() int32 { return Echo(9) }
    }
}
class Implementation : Outer.Nested { }
let item Outer.Nested = Implementation()
System.Console.Write(item.Read())
`
        CompileVerifyAndRun(source, "9")
    }

    @Theory
    @InlineData("int32", "9", "19", "9", "19", false)
    @InlineData("int32", "9", "19", "9", "19", true)
    @InlineData("string", `"base"`, `"override"`, "base", "override", false)
    @InlineData("string", `"base"`, `"override"`, "base", "override", true)
    func InheritedSlot_PreservesArgumentsDispatchAndEvaluation(
        type string,
        argument string,
        replacement string,
        expected string,
        overridden string,
        nested bool
    ) {
        let reader = `interface Reader : IBox[` + type + `] {
    func Read(value ` + type + `) ` + type + ` { return Echo(value) }
    func ReadGeneric(value ` + type + `) int32 { return Pick[int32](value, 4) }
    func ReadGenericReference(value ` + type + `) string { return Pick[string](value, "tag") }
    func Echo(flag bool) bool {
        System.Console.Write("L")
        return !flag
    }
}`
        let readerName = if nested {
            "Outer.Reader"
        } else {
            "Reader"
        }
        let source = `interface IBox[T] {
    func Echo(value T) T {
        System.Console.Write("D")
        return value
    }
    func Echo(count int32, value T) T {
        System.Console.Write("O")
        System.Console.Write(count)
        return value
    }
    func Pick[U](value T, other U) U {
        System.Console.Write("G")
        System.Console.Write(value)
        System.Console.Write(":")
        return other
    }
}
interface Forward[T] : IBox[T] {
    func Read(value T) T { return Echo(value) }
}
class Generic : Forward[` + type + `] { }
` + (
            if nested {
                "class Outer {\n" + reader + "\n}"
            } else {
                reader
            }
        ) + `
class Default : ` + readerName + ` { }
class Override : ` + readerName + ` {
    func Echo(value ` + type + `) ` + type + ` {
        System.Console.Write("V")
        return ` + replacement + `
    }
    func Echo(count int32, value ` + type + `) ` + type + ` { return value }
    func Echo(flag bool) bool { return !flag }
}
class Trace {
    shared {
        func Target() ` + readerName + ` {
            System.Console.Write("R")
            return Override()
        }
        func Argument() ` + type + ` {
            System.Console.Write("A")
            return ` + argument + `
        }
    }
}
let direct IBox[` + type + `] = Default()
let forwarded Forward[` + type + `] = Generic()
let inherited ` + readerName + ` = Default()
System.Console.Write(direct.Echo(` + argument + `))
System.Console.Write("|")
System.Console.Write(forwarded.Read(` + argument + `))
System.Console.Write("|")
System.Console.Write(inherited.Read(` + argument + `))
System.Console.Write("|")
System.Console.Write(inherited.ReadGeneric(` + argument + `))
System.Console.Write("|")
System.Console.Write(inherited.ReadGenericReference(` + argument + `))
System.Console.Write("|")
System.Console.Write(inherited.Echo(true))
System.Console.Write("|")
System.Console.Write(Trace.Target().Read(Trace.Argument()))
System.Console.Write("|")
System.Console.Write(Trace.Target().Echo(Trace.Argument()))
System.Console.Write("|")
System.Console.Write(inherited.Echo(2, ` + argument + `))
`
        CompileVerifyAndRun(
            source,
            "D" +
                expected +
                "|D" +
                expected +
                "|D" +
                expected +
                "|G" +
                expected +
                ":4|G" +
                expected +
                ":tag|LFalse|RAV" +
                overridden +
                "|RAV" +
                overridden +
                "|O2" +
                expected
        )
    }

    shared {
        internal func CompileVerifyAndRun(
            source string,
            expected string,
            issue string = "5392",
            reference string? = nil,
            runtimeReference string? = nil
        ) {
            var root DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while root != nil && !RepositoryRootMarker.IsRoot(root.FullName) {
                root = root.Parent
            }
            Assert.NotNull(root)
            let directory = Path.Combine(root!!.FullName, "out", issue, "tests", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let assemblyPath = Path.Combine(directory, "Program.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/deterministic+",
                    "/debug:none",
                    "/out:" + assemblyPath,
                    sourcePath
                }
                if reference != nil {
                    arguments.Add("/reference:" + reference)
                }
                if runtimeReference != nil {
                    File.Copy(runtimeReference, Path.Combine(directory, Path.GetFileName(runtimeReference)))
                }
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let originalOut = Console.Out
                let originalError = Console.Error
                var code int32
                try {
                    Console.SetOut(stdout)
                    Console.SetError(stderr)
                    code = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(originalOut)
                    Console.SetError(originalError)
                }
                Assert.True(code == 0, stdout.ToString() + stderr.ToString())
                Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
                IlVerifier.Verify(
                    assemblyPath,
                    additionalReferences: if runtimeReference != nil {
                        []string{runtimeReference}
                    } else {
                        []string{}
                    }
                )
                let start = ProcessStartInfo("dotnet"){
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    WorkingDirectory = directory
                }
                start.ArgumentList.Add(assemblyPath)
                using let process = Process.Start(start)!!
                let error = process.StandardError.ReadToEndAsync()
                using let output = MemoryStream()
                let read = process.StandardOutput.BaseStream.CopyToAsync(output)
                var exited bool
                try {
                    exited = process.WaitForExit(30_000)
                } finally {
                    if !process.HasExited {
                        process.Kill(entireProcessTree: true)
                    }
                    process.WaitForExit()
                    try {
                        read.GetAwaiter().GetResult()
                    } finally {
                        error.GetAwaiter().GetResult()
                    }
                }
                Assert.True(exited, "interface consumer timed out")
                let errorText = error.GetAwaiter().GetResult()
                Assert.True(process.ExitCode == 0, errorText)
                Assert.Equal("", errorText)
                Assert.Equal(Encoding.UTF8.GetBytes(expected), output.ToArray())
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
