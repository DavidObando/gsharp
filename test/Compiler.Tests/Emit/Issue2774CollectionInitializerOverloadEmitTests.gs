// <copyright file="Issue2774CollectionInitializerOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #2774: a single non-literal collection element must be parsed and
/// lowered through the normal overloaded `Add` call path.
class Issue2774CollectionInitializerOverloadEmitTests {
    @Fact
    func ImportedOverloads_SelectBestBaseInterfaceAndNullableConversions() {
        const source = `package Issue2774.App
import System
import Issue2774.Contracts

let item = DerivedItem()
let byBase = OverloadBag(){ item }
let byInterface = InterfaceBag(){ item }
let number int32 = 7
let byNullable = NullableBag(){ number }
let byNumeric = NumericBag(){ number }
Console.WriteLine(byBase.Choice)
Console.WriteLine(byInterface.Choice)
Console.WriteLine(byNullable.Choice)
Console.WriteLine(byNumeric.Choice)`
        using let result = Compile(source, includeContracts: true)
        Assert.Equal(
            "base${Environment.NewLine}interface${Environment.NewLine}nullable${Environment.NewLine}long${Environment.NewLine}",
            Run(result.OutputPath)
        )
    }

    @Fact
    func SourceDeclaredAddDetection_MatchesNormalCallBinding() {
        const source = `package Issue2774.Local
import System
import System.Collections
import System.Collections.Generic

open class BaseItem {}
class DerivedItem : BaseItem {}

class LocalBag : IEnumerable {
    let items List[object] = List[object]()
    func Add(value object) { items.Add(value) }
    func GetEnumerator() IEnumerator -> items.GetEnumerator()
    prop Count int32 -> items.Count
}

class LocalOverloadBag : IEnumerable {
    let choice List[string] = List[string]()
    func Add(value object) { choice.Add("object") }
    func Add(value BaseItem) { choice.Add("base") }
    func GetEnumerator() IEnumerator -> choice.GetEnumerator()
    prop Choice string -> choice[0]
}

let item = DerivedItem()
let bag = LocalBag(){ item, "value" }
let overloaded = LocalOverloadBag(){ item }
Console.WriteLine(bag.Count)
Console.WriteLine(overloaded.Choice)`
        using let result = Compile(source)
        Assert.Equal("2${Environment.NewLine}base${Environment.NewLine}", Run(result.OutputPath))
    }

    @Fact
    func SingleAddListAndHashSet_WithIdentifierElements_StillRun() {
        const source = `package Issue2774.Collections
import System
import System.Collections.Generic

let number int32 = 42
let text = "value"
let list = List[int32](){ number }
let set = HashSet[string](){ text }
Console.WriteLine(list.Count)
Console.WriteLine(list[0])
Console.WriteLine(set.Count)
Console.WriteLine(set.Contains(text))`
        using let result = Compile(source)
        Assert.Equal(
            "1${Environment.NewLine}42${Environment.NewLine}1${Environment.NewLine}True${Environment.NewLine}",
            Run(result.OutputPath)
        )
    }

    @Fact
    func InitializerEvaluationOrder_RemainsConstructorThenElementThenAdd() {
        const source = `package Issue2774.Ordering
import System
import Issue2774.Contracts

let bag = OrderedBag(){ Order.Eval(1), Order.Eval(2) }
Console.WriteLine(String.Join(",", Order.Events))`
        using let result = Compile(source, includeContracts: true)
        Assert.Equal("ctor,eval1,add1,eval2,add2${Environment.NewLine}", Run(result.OutputPath))
    }

    @Fact
    func SystemCommandLine_SingleElementBuilders_RegisterAllElements() {
        const source = `package Issue2774.Commands
import System
import System.CommandLine

let historyShowArg = Argument[string]("id")
let historyShow = Command("show", "history show"){ historyShowArg }
let retryArg = Argument[string]("id")
let historyRetry = Command("retry", "history retry"){ retryArg }
let asinArg = Argument[string]("asin")
let libraryShow = Command("show", "library show"){ asinArg }
let removeArg = Argument[string]("asin")
let queueRemove = Command("remove", "queue remove"){ removeArg }
let profileOpt = Option[string]("--profile")
let authLogout = Command("logout", "auth logout"){ profileOpt }
let shellArg = Argument[string]("shell")
let completion = Command("completion", "completion"){ shellArg }
let keyArg = Argument[string]("key")
let configGet = Command("get", "config get"){ keyArg }

Console.WriteLine(historyShow.Arguments.Count)
Console.WriteLine(historyRetry.Arguments.Count)
Console.WriteLine(libraryShow.Arguments.Count)
Console.WriteLine(queueRemove.Arguments.Count)
Console.WriteLine(authLogout.Options.Count)
Console.WriteLine(completion.Arguments.Count)
Console.WriteLine(configGet.Arguments.Count)
Console.WriteLine(historyRetry.Parse([]string{"job-1"}).Errors.Count)
Console.WriteLine(libraryShow.Parse([]string{"asin-1"}).Errors.Count)`
        using let result = Compile(
            source,
            additionalReferences: []string{Path.Combine(AppContext.BaseDirectory, "System.CommandLine.dll")},
            outOfProcess: true,
            useExplicitBclReferences: true
        )
        Assert.Equal(
            "1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}0${Environment.NewLine}0${Environment.NewLine}",
            Run(result.OutputPath)
        )
    }

    @Fact
    func AmbiguousAdd_IsRejected() {
        const source = `package Issue2774.Ambiguous
import Issue2774.Contracts

let item = DerivedItem()
let bag = AmbiguousBag(){ item }`
        using let result = Compile(source, includeContracts: true, expectSuccess: false)
        Assert.Contains("GS0160", result.Diagnostics)
    }

    @Fact
    func NoApplicableAdd_IsRejected() {
        const source = `package Issue2774.NoApplicable
import Issue2774.Contracts

let text = "value"
let bag = NoApplicableBag(){ text }`
        using let result = Compile(source, includeContracts: true, expectSuccess: false)
        Assert.Contains("GS0159", result.Diagnostics)
    }

    private class CompilationResult : IDisposable {
        init(directoryPath string, outputPath string, diagnostics string) {
            DirectoryPath = directoryPath
            OutputPath = outputPath
            Diagnostics = diagnostics
        }

        prop DirectoryPath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop Diagnostics string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(DirectoryPath, recursive: true)
            } catch { }
        }
    }

    shared {
        private const ContractsSource string = `using System;
using System.Collections;
using System.Collections.Generic;

namespace Issue2774.Contracts
{
    public class BaseItem { }
    public interface IItem { }
    public sealed class DerivedItem : BaseItem, IItem { }

    public sealed class OverloadBag : IEnumerable
    {
        public string Choice { get; private set; } = "";
        public void Add(object value) => Choice = "object";
        public void Add(BaseItem value) => Choice = "base";
        public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
    }

    public sealed class InterfaceBag : IEnumerable
    {
        public string Choice { get; private set; } = "";
        public void Add(object value) => Choice = "object";
        public void Add(IItem value) => Choice = "interface";
        public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
    }

    public sealed class NullableBag : IEnumerable
    {
        public string Choice { get; private set; } = "";
        public void Add(int? value) => Choice = "nullable";
        public void Add(string value) => Choice = "string";
        public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
    }

    public sealed class NumericBag : IEnumerable
    {
        public string Choice { get; private set; } = "";
        public void Add(long value) => Choice = "long";
        public void Add(string value) => Choice = "string";
        public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
    }

    public sealed class AmbiguousBag : IEnumerable
    {
        public void Add(BaseItem value) { }
        public void Add(IItem value) { }
        public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
    }

    public sealed class NoApplicableBag : IEnumerable
    {
        public void Add(BaseItem value) { }
        public void Add(IItem value) { }
        public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
    }

    public static class Order
    {
        public static readonly List<string> Events = new();
        public static int Eval(int value)
        {
            Events.Add("eval" + value);
            return value;
        }
    }

    public sealed class OrderedBag : IEnumerable
    {
        public OrderedBag() => Order.Events.Add("ctor");
        public void Add(int? value) => Order.Events.Add("add" + value);
        public void Add(string value) => Order.Events.Add("string");
        public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
    }
}`

        private func Compile(
            source string,
            includeContracts bool = false,
            additionalReferences IReadOnlyList[string]? = nil,
            expectSuccess bool = true,
            outOfProcess bool = false,
            useExplicitBclReferences bool = false
        ) Issue2774CollectionInitializerOverloadEmitTests
            .CompilationResult {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2774", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            let references = List[string]()
            if includeContracts {
                references.Add(EmitContracts(directory))
            }
            if additionalReferences != nil {
                references.AddRange(additionalReferences)
            }
            let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
            if useExplicitBclReferences {
                args.AddRange(GetBclReferences().Select((reference string) -> ("/reference:" + reference)))
            }
            args.AddRange(references.Select((reference string) -> ("/reference:" + reference)))
            args.Add(sourcePath)
            var exitCode int32
            var stdout string
            var stderr string
            if outOfProcess {
                let processInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                processInfo.ArgumentList.Add(
                    Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
                )
                for argument in args {
                    processInfo.ArgumentList.Add(argument)
                }
                using let process = Process.Start(processInfo)!!
                stdout = process.StandardOutput.ReadToEnd()
                stderr = process.StandardError.ReadToEnd()
                process.WaitForExit()
                exitCode = process.ExitCode
            } else {
                using let capturedOut = StringWriter()
                using let capturedError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(capturedOut)
                Console.SetError(capturedError)
                try {
                    exitCode = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                stdout = capturedOut.ToString()
                stderr = capturedError.ToString()
            }
            let diagnostics = stdout + stderr
            if expectSuccess {
                Assert.True(exitCode == 0, diagnostics)
                IlVerifier.Verify(outputPath, additionalReferences: references)
                for reference in references {
                    let destination = Path.Combine(directory, Path.GetFileName(reference))
                    if !string.Equals(reference, destination, StringComparison.Ordinal) {
                        File.Copy(reference, destination, overwrite: true)
                    }
                }
            } else {
                Assert.NotEqual(0, exitCode)
            }
            return Issue2774CollectionInitializerOverloadEmitTests.CompilationResult(directory, outputPath, diagnostics)
        }

        private func EmitContracts(directory string) string {
            let outputPath = Path.Combine(directory, "Issue2774.Contracts.dll")
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Issue2774.Contracts",
                []SyntaxTree{CSharpSyntaxTree.ParseText(ContractsSource, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            Assert.False(string.IsNullOrWhiteSpace(value))
            return value!!.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
        }

        private func GetBclReferences() IReadOnlyList[string] {
            let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let dotnetRoot = Directory.GetParent(runtimeDirectory)!!.Parent!!.Parent!!.FullName
            let tfm = "net${Environment.Version.Major}.0"
            let packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            let referenceDirectory = Directory
                .EnumerateDirectories(packsRoot, Environment.Version.Major.ToString() + ".*")
                .OrderByDescending((path string) -> path, StringComparer.Ordinal)
                .Select((path string) -> Path.Combine(path, "ref", tfm))
                .First(Directory.Exists)
            return Directory.EnumerateFiles(referenceDirectory, "*.dll").ToList()
        }

        private func Run(outputPath string) string {
            File.WriteAllText(Path.ChangeExtension(outputPath, "runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let processInfo = ProcessStartInfo("dotnet", "exec \"" + outputPath + "\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process = Process.Start(processInfo)!!
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            process.WaitForExit()
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
