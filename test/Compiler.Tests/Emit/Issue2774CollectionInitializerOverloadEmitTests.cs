// <copyright file="Issue2774CollectionInitializerOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2774: a single non-literal collection element must be parsed and
/// lowered through the normal overloaded <c>Add</c> call path.
/// </summary>
public sealed class Issue2774CollectionInitializerOverloadEmitTests
{
    private const string ContractsSource = """
        using System;
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
        }
        """;

    [Fact]
    public void ImportedOverloads_SelectBestBaseInterfaceAndNullableConversions()
    {
        const string source = """
            package Issue2774.App
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
            Console.WriteLine(byNumeric.Choice)
            """;

        using var result = Compile(source, includeContracts: true);
        Assert.Equal("base\ninterface\nnullable\nlong\n", Run(result.OutputPath));
    }

    [Fact]
    public void SourceDeclaredAddDetection_MatchesNormalCallBinding()
    {
        const string source = """
            package Issue2774.Local
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
            Console.WriteLine(overloaded.Choice)
            """;

        using var result = Compile(source);
        Assert.Equal("2\nbase\n", Run(result.OutputPath));
    }

    [Fact]
    public void SingleAddListAndHashSet_WithIdentifierElements_StillRun()
    {
        const string source = """
            package Issue2774.Collections
            import System
            import System.Collections.Generic

            let number int32 = 42
            let text = "value"
            let list = List[int32](){ number }
            let set = HashSet[string](){ text }
            Console.WriteLine(list.Count)
            Console.WriteLine(list[0])
            Console.WriteLine(set.Count)
            Console.WriteLine(set.Contains(text))
            """;

        using var result = Compile(source);
        Assert.Equal("1\n42\n1\nTrue\n", Run(result.OutputPath));
    }

    [Fact]
    public void InitializerEvaluationOrder_RemainsConstructorThenElementThenAdd()
    {
        const string source = """
            package Issue2774.Ordering
            import System
            import Issue2774.Contracts

            let bag = OrderedBag(){ Order.Eval(1), Order.Eval(2) }
            Console.WriteLine(String.Join(",", Order.Events))
            """;

        using var result = Compile(source, includeContracts: true);
        Assert.Equal("ctor,eval1,add1,eval2,add2\n", Run(result.OutputPath));
    }

    [Fact]
    public void SystemCommandLine_SingleElementBuilders_RegisterAllElements()
    {
        const string source = """
            package Issue2774.Commands
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
            Console.WriteLine(libraryShow.Parse([]string{"asin-1"}).Errors.Count)
            """;

        using var result = Compile(
            source,
            additionalReferences: new[] { Path.Combine(AppContext.BaseDirectory, "System.CommandLine.dll") },
            outOfProcess: true,
            useExplicitBclReferences: true);
        Assert.Equal("1\n1\n1\n1\n1\n1\n1\n0\n0\n", Run(result.OutputPath));
    }

    [Fact]
    public void AmbiguousAdd_IsRejected()
    {
        const string source = """
            package Issue2774.Ambiguous
            import Issue2774.Contracts

            let item = DerivedItem()
            let bag = AmbiguousBag(){ item }
            """;

        using var result = Compile(source, includeContracts: true, expectSuccess: false);
        Assert.Contains("GS0160", result.Diagnostics);
    }

    [Fact]
    public void NoApplicableAdd_IsRejected()
    {
        const string source = """
            package Issue2774.NoApplicable
            import Issue2774.Contracts

            let text = "value"
            let bag = NoApplicableBag(){ text }
            """;

        using var result = Compile(source, includeContracts: true, expectSuccess: false);
        Assert.Contains("GS0159", result.Diagnostics);
    }

    private static CompilationResult Compile(
        string source,
        bool includeContracts = false,
        IReadOnlyList<string> additionalReferences = null,
        bool expectSuccess = true,
        bool outOfProcess = false,
        bool useExplicitBclReferences = false)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2774",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        var references = new List<string>();
        if (includeContracts)
        {
            references.Add(EmitContracts(directory));
        }

        if (additionalReferences != null)
        {
            references.AddRange(additionalReferences);
        }

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        if (useExplicitBclReferences)
        {
            args.AddRange(GetBclReferences().Select(reference => "/reference:" + reference));
        }

        args.AddRange(references.Select(reference => "/reference:" + reference));
        args.Add(sourcePath);

        int exitCode;
        string stdout;
        string stderr;
        if (outOfProcess)
        {
            var processInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            processInfo.ArgumentList.Add(Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll")));
            foreach (var argument in args)
            {
                processInfo.ArgumentList.Add(argument);
            }

            using var process = Process.Start(processInfo)!;
            stdout = process.StandardOutput.ReadToEnd();
            stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            exitCode = process.ExitCode;
        }
        else
        {
            using var capturedOut = new StringWriter();
            using var capturedError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(capturedOut);
            Console.SetError(capturedError);
            try
            {
                exitCode = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            stdout = capturedOut.ToString();
            stderr = capturedError.ToString();
        }

        var diagnostics = stdout + stderr;
        if (expectSuccess)
        {
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outputPath, additionalReferences: references);
            foreach (var reference in references)
            {
                var destination = Path.Combine(directory, Path.GetFileName(reference));
                if (!string.Equals(reference, destination, StringComparison.Ordinal))
                {
                    File.Copy(reference, destination, overwrite: true);
                }
            }
        }
        else
        {
            Assert.NotEqual(0, exitCode);
        }

        return new CompilationResult(directory, outputPath, diagnostics);
    }

    private static string EmitContracts(string directory)
    {
        var outputPath = Path.Combine(directory, "Issue2774.Contracts.dll");
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2774.Contracts",
            new[] { CSharpSyntaxTree.ParseText(ContractsSource, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        Assert.False(string.IsNullOrWhiteSpace(value));
        return value!.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
    }

    private static IReadOnlyList<string> GetBclReferences()
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var dotnetRoot = Directory.GetParent(runtimeDirectory)!.Parent!.Parent!.FullName;
        var tfm = $"net{Environment.Version.Major}.0";
        var packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        var referenceDirectory = Directory.EnumerateDirectories(packsRoot, Environment.Version.Major + ".*")
            .OrderByDescending(path => path, StringComparer.Ordinal)
            .Select(path => Path.Combine(path, "ref", tfm))
            .First(Directory.Exists);
        return Directory.EnumerateFiles(referenceDirectory, "*.dll").ToList();
    }

    private static string Run(string outputPath)
    {
        File.WriteAllText(Path.ChangeExtension(outputPath, "runtimeconfig.json"), """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);

        var processInfo = new ProcessStartInfo("dotnet", "exec \"" + outputPath + "\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using var process = Process.Start(processInfo)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(string directoryPath, string outputPath, string diagnostics)
        {
            DirectoryPath = directoryPath;
            OutputPath = outputPath;
            Diagnostics = diagnostics;
        }

        public string DirectoryPath { get; }

        public string OutputPath { get; }

        public string Diagnostics { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
            catch
            {
            }
        }
    }
}
