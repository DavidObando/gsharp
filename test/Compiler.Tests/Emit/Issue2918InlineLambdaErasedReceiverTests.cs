// <copyright file="Issue2918InlineLambdaErasedReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Sdk;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2918: inline lambdas passed through imported generic receivers keep
/// the receiver's symbolic delegate type instead of binding against its erased
/// CLR projection.
/// </summary>
public class Issue2918InlineLambdaErasedReceiverTests
{
    private const string Contracts = """
        using System;

        namespace Issue2918Contracts;

        public sealed class Slot<T>
        {
            private T value;

            public Slot(T value) => this.value = value;

            public void Put(int tag, T value) => this.value = value;

            public T this[int index]
            {
                get => this.value;
                set => this.value = value;
            }

            public T Get() => this.value;

            public void Apply(Action<T> apply) => apply(this.value);
        }

        public static class GenericSink
        {
            private static Delegate? last;

            public static void M<T>(T value) => last = (Delegate)(object)value!;

            public static void InvokeLast(object argument) => last!.DynamicInvoke(argument);
        }

        public sealed class Holder<T>
        {
            public Holder(Action<T> callback) => Kind = "symbolic";

            public Holder(Action<int> callback) => Kind = "closed";

            public string Kind { get; }
        }

        public sealed class PredHolder<T>
        {
            public PredHolder(Predicate<T> callback) => Kind = "pred";

            public string Kind { get; }
        }

        public sealed class DelegateBox<T>
        {
            public DelegateBox(T value) => Value = value;

            public T Value { get; }

            public string RuntimeTypeName =>
                Value!.GetType().GetGenericTypeDefinition().FullName!;
        }
        """;

    [Fact]
    public void ImportedGenericReceiverMethods_TargetInlineLambdas_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2918Receivers
            import System
            import System.Collections.Generic
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            struct Pt { var N int32 }

            enum Mode { First, Second }

            interface IValue {
                func Value() int32;
            }

            class ValueImpl : IValue {
                let N int32
                init(n int32) { N = n }
                func Value() int32 -> N
            }

            class Wrapper[T any] {
                let Value T
                init(value T) { Value = value }
            }

            func PrintSrc(item Src) { Console.WriteLine(item.N) }

            func Main() {
                let callbacks = List[System.Action[Src]]()
                callbacks.Add((item Src) -> Console.WriteLine(item.N))
                callbacks[0](Src(1))

                let nestedCallbacks = List[System.Action[List[Src]]]()
                nestedCallbacks.Add((items List[Src]) -> Console.WriteLine(items[0].N))
                nestedCallbacks[0](List[Src]{ Src(2) })

                let transforms = List[System.Func[Src, int32]]()
                transforms.Add((item Src) -> item.N)
                Console.WriteLine(transforms[0](Src(3)))

                let byName = Dictionary[string, System.Action[Src]]()
                byName.Add("x", (item Src) -> Console.WriteLine(item.N))
                byName["x"](Src(4))

                let seed System.Action[Src] = PrintSrc
                let secondArg = Slot[System.Action[Src]](seed)
                secondArg.Put(1, (item Src) -> Console.WriteLine(item.N))
                let secondHandler System.Action[Src] = secondArg.Get()
                secondHandler(Src(8))

                let nestedLambda = List[System.Func[Src, System.Action[Src]]]()
                nestedLambda.Add(
                    (outer Src) -> (inner Src) -> Console.WriteLine(outer.N + inner.N))
                nestedLambda[0](Src(5))(Src(7))

                let inferred = List[System.Action[Src]]()
                inferred.Add((item) -> Console.WriteLine(item.N))
                inferred[0](Src(13))

                let structCallbacks = List[System.Action[Pt]]()
                structCallbacks.Add((item Pt) -> Console.WriteLine(item.N))
                structCallbacks[0](Pt{N: 16})

                let enumCallbacks = List[System.Action[Mode]]()
                enumCallbacks.Add((item Mode) -> Console.WriteLine(17))
                enumCallbacks[0](Mode.Second)

                let interfaceCallbacks = List[System.Action[IValue]]()
                interfaceCallbacks.Add((item IValue) -> Console.WriteLine(item.Value()))
                interfaceCallbacks[0](ValueImpl(18))

                let wrappedCallbacks = List[System.Action[Wrapper[Src]]]()
                wrappedCallbacks.Add(
                    (item Wrapper[Src]) -> Console.WriteLine(item.Value.N))
                wrappedCallbacks[0](Wrapper[Src](Src(19)))

                let unqualified = List[Action[Src]]()
                unqualified.Add((item Src) -> Console.WriteLine(item.N))
                unqualified[0](Src(20))
            }
            """;

        Assert.Equal(
            "1\n2\n3\n4\n8\n12\n13\n16\n17\n18\n19\n20\n",
            CompileVerifyLoadAndRun(source, "Issue2918Receivers.Src"));
    }

    [Fact]
    public void MismatchedInlineLambdaArityThroughErasedSlot_IsRejected()
    {
        const string source = """
            package LambdaArityErasure
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let callbacks = List[System.Action[Src]]()
                callbacks.Add((left Src, right Src) -> Console.WriteLine(left.N + right.N))
            }
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains(
            "GS0144: Function 'lambda' requires 1 arguments but was given 2.",
            diagnostics,
            StringComparison.Ordinal);
    }

    [Fact]
    public void MatchingInlineLambdaArityThroughErasedSlot_VerifyLoadAndRun()
    {
        const string source = """
            package LambdaArityMatch
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let callbacks = List[System.Action[Src]]()
                callbacks.Add((item Src) -> Console.WriteLine(item.N))
                callbacks[0](Src(7))
            }
            """;

        Assert.Equal(
            "7\n",
            CompileVerifyLoadAndRun(source, "LambdaArityMatch.Src"));
    }

    [Fact]
    public void ImportedGenericConstructor_TargetsInlineLambda_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2918Constructor
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let slot = Slot[System.Action[Src]](
                    (item Src) -> Console.WriteLine(item.N))
                let handler System.Action[Src] = slot.Get()
                handler(Src(10))
            }
            """;

        Assert.Equal(
            "10\n",
            CompileVerifyLoadAndRun(source, "Issue2918Constructor.Src"));
    }

    [Fact]
    public void ImportedConstructedPredicateConstructor_TargetsInlineLambda_LoadsAndRuns()
    {
        const string source = """
            package Issue2918PredicateHolder
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let holder = PredHolder[Src]((item Src) -> item.N > 2)
                Console.WriteLine(holder.Kind)
            }
            """;

        // Direct named-delegate construction retains the pre-existing #313/#939
        // IL mismatch on main; real execution is the compatibility pin here.
        Assert.Equal(
            "pred\n",
            CompileVerifyLoadAndRun(
                source,
                "Issue2918PredicateHolder.Src",
                verifyIl: false));
    }

    [Fact]
    public void ImportedGenericConstructorOverloads_DisagreeWithoutForcingSymbolicTarget_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2918ConstructorOverloads
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let symbolic = Holder[Src](
                    (item Src) -> Console.WriteLine(item.N))
                Console.WriteLine(symbolic.Kind)

                let closed = Holder[Src](
                    (item int32) -> Console.WriteLine(item))
                Console.WriteLine(closed.Kind)
            }
            """;

        Assert.Equal(
            "symbolic\nclosed\n",
            CompileVerifyLoadAndRun(source, "Issue2918ConstructorOverloads.Src"));
    }

    [Fact]
    public void ImportedPredicateThroughErasedListSlot_IsRejected()
    {
        const string source = """
            package Issue2918PredicateSlot
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let predicates = List[Predicate[Src]]()
                predicates.Add((item Src) -> item.N > 2)
            }
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0159", diagnostics, StringComparison.Ordinal);
        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedComparisonThroughErasedListSlot_IsRejected()
    {
        const string source = """
            package Issue2918ComparisonSlot
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let comparisons = List[Comparison[Src]]()
                comparisons.Add((left Src, right Src) -> left.N - right.N)
            }
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0159", diagnostics, StringComparison.Ordinal);
        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedPredicateThroughErasedConstructorSlot_IsRejected()
    {
        const string source = """
            package Issue2918PredicateConstructor
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let box = DelegateBox[Predicate[Src]](
                    (item Src) -> item.N > 2)
                Console.WriteLine(box.RuntimeTypeName)
                Console.WriteLine(box.Value(Src(3)))
            }
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0159", diagnostics, StringComparison.Ordinal);
        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void HoistedImportedPredicateThroughGenericConstructor_RetainsDelegateIdentity()
    {
        const string source = """
            package Issue2918PredicateHoisted
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let predicate Predicate[Src] = (item Src) -> item.N > 2
                let box = DelegateBox[Predicate[Src]](predicate)
                Console.WriteLine(box.RuntimeTypeName)
                Console.WriteLine(box.Value!!(Src(3)))
            }
            """;

        Assert.Equal(
            "System.Predicate`1\nTrue\n",
            CompileVerifyLoadAndRun(
                source,
                "Issue2918PredicateHoisted.Src",
                verifyIl: false));
    }

    [Fact]
    public void PublicLibraryDelegateSignatures_RoundTripThroughCSharp()
    {
        var directory = CreateDirectory("Issue2918_PublicApi_");
        try
        {
            var librarySourcePath = Path.Combine(directory, "library.gs");
            var libraryPath = Path.Combine(directory, "Issue2918PublicApi.dll");
            File.WriteAllText(librarySourcePath, """
                package Issue2918PublicApi
                import System
                import System.Collections.Generic

                class Src {
                    let N int32
                    init(n int32) { N = n }
                }

                class Api {
                    shared {
                        func Callbacks() List[System.Action[Src]] {
                            let callbacks = List[System.Action[Src]]()
                            callbacks.Add((item Src) -> Console.WriteLine(item.N))
                            return callbacks
                        }

                        func Transforms() Dictionary[string, System.Func[Src, int32]] {
                            let transforms =
                                Dictionary[string, System.Func[Src, int32]]()
                            transforms.Add("value", (item Src) -> item.N)
                            return transforms
                        }
                    }
                }
                """);
            Compile(
            [
                "/out:" + libraryPath,
                "/target:library",
                "/targetframework:net10.0",
                librarySourcePath,
            ]);
            IlVerifier.Verify(libraryPath);

            var consumerPath = Path.Combine(directory, "consumer.dll");
            CompileCSharp(
                """
                using System;
                using System.Collections.Generic;
                using Issue2918PublicApi;

                namespace Consumer;

                public static class Runner
                {
                    public static int Run()
                    {
                        List<Action<Src>> callbacks = Api.Callbacks();
                        Dictionary<string, Func<Src, int>> transforms = Api.Transforms();
                        return callbacks.Count + transforms["value"](new Src(41));
                    }
                }
                """,
                consumerPath,
                "Issue2918CSharpConsumer",
                libraryPath);
            IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

            var loadContext = new AssemblyLoadContext(
                "Issue2918_PublicApi_" + Guid.NewGuid().ToString("N"),
                isCollectible: true);
            try
            {
                var library = loadContext.LoadFromAssemblyPath(libraryPath);
                loadContext.Resolving += (_, name) =>
                    name.Name == library.GetName().Name ? library : null;
                Assert.NotEmpty(library.GetTypes());

                var consumer = loadContext.LoadFromAssemblyPath(consumerPath);
                Assert.NotEmpty(consumer.GetTypes());
                var run = consumer.GetType("Consumer.Runner")!.GetMethod("Run")!;
                Assert.Equal(42, run.Invoke(null, null));
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public void ExistingDelegateTargetingControls_RemainValid_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2918Guards
            import System
            import System.Collections.Generic
            import System.Linq
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            class Box[T any] {
                var Value T
                init(value T) { Value = value }
                func Put(value T) { Value = value }
            }

            func PrintSrc(item Src) { Console.WriteLine(item.N) }
            func Identity[T](value T) T -> value

            func Main() {
                let arrayCallbacks []System.Action[Src] = []System.Action[Src]{
                    (item Src) -> Console.WriteLine(item.N)
                }
                arrayCallbacks[0](Src(5))

                let pair (System.Action[Src], int32) = (
                    (item Src) -> Console.WriteLine(item.N),
                    0)
                let (pairCallback, _) = pair
                pairCallback(Src(6))

                let sourceBox = Box[System.Action[Src]](
                    (item Src) -> Console.WriteLine(item.N))
                sourceBox.Put((item Src) -> Console.WriteLine(item.N))
                sourceBox.Value(Src(7))

                let items = List[Src]{ Src(9) }
                items.ForEach((item Src) -> Console.WriteLine(item.N))

                let seed System.Action[Src] = PrintSrc
                let indexed = Slot[System.Action[Src]](seed)
                indexed[0] = (item Src) -> Console.WriteLine(item.N)
                let indexedHandler System.Action[Src] = indexed.Get()
                indexedHandler(Src(11))

                Identity[System.Action[Src]](
                    (item Src) -> Console.WriteLine(item.N))(Src(14))

                GenericSink.M[System.Action[Src]](
                    (item Src) -> Console.WriteLine(item.N))
                GenericSink.InvokeLast(Src(15))

                let groups = List[System.Action[Src]]()
                groups.Add(PrintSrc)
                groups[0](Src(21))

                let hoisted System.Action[Src] =
                    (item Src) -> Console.WriteLine(item.N)
                let hoistedList = List[System.Action[Src]]()
                hoistedList.Add(hoisted)
                hoistedList[0](Src(22))

                Console.WriteLine(
                    List[Src]{ Src(23) }
                        .Where((item Src) -> item.N > 0)
                        .Single()
                        .N)

                let values = List[Src]{ Src(24) }
                var enumerator List[Src].Enumerator = values.GetEnumerator()
                if enumerator.MoveNext() {
                    Console.WriteLine(enumerator.Current.N)
                }

                let applied = Slot[System.Action[Src]](seed)
                applied.Apply(
                    (callback System.Action[Src]) -> callback(Src(25)))
            }
            """;

        Assert.Equal(
            "5\n6\n7\n9\n11\n14\n15\n21\n22\n23\n24\n25\n",
            CompileVerifyLoadAndRun(source, "Issue2918Guards.Src"));
    }

    [Fact]
    public void IlVerifier_RejectsDeliberatelyBrokenAssembly()
    {
        var directory = CreateDirectory("Issue2918_BrokenIl_");
        try
        {
            var validPath = Path.Combine(directory, "valid.dll");
            CompileCSharp(
                """
                public static class BrokenProbe
                {
                    public static int Broken() => 1;
                }
                """,
                validPath,
                "Issue2918BrokenProbe");

            var brokenPath = Path.Combine(directory, "broken.dll");
            var bytes = File.ReadAllBytes(validPath);
            using (var peReader = new PEReader(new MemoryStream(bytes, writable: false)))
            {
                var metadata = peReader.GetMetadataReader();
                var method = metadata.MethodDefinitions
                    .Select(metadata.GetMethodDefinition)
                    .Single(definition => metadata.GetString(definition.Name) == "Broken");
                var section = peReader.PEHeaders.SectionHeaders.Single(header =>
                    method.RelativeVirtualAddress >= header.VirtualAddress
                    && method.RelativeVirtualAddress < header.VirtualAddress + header.VirtualSize);
                var bodyOffset = method.RelativeVirtualAddress
                    - section.VirtualAddress
                    + section.PointerToRawData;
                var header = bytes[bodyOffset];
                var codeOffset = (header & 0x3) == 0x2
                    ? bodyOffset + 1
                    : bodyOffset
                        + ((BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(bodyOffset, 2)) >> 12) * 4);
                bytes[codeOffset] = 0x2A;
            }

            File.WriteAllBytes(brokenPath, bytes);
            var error = Assert.Throws<XunitException>(() => IlVerifier.Verify(brokenPath));
            Assert.Contains("invalid IL", error.Message, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static string CompileVerifyLoadAndRun(
        string source,
        string expectedSourceTypeName,
        bool verifyIl = true)
    {
        var directory = CreateDirectory("Issue2918_");
        try
        {
            var contractsPath = Path.Combine(directory, "Issue2918Contracts.dll");
            CompileCSharp(Contracts, contractsPath, "Issue2918Contracts");
            IlVerifier.Verify(contractsPath);

            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            Compile(
            [
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/r:" + contractsPath,
                sourcePath,
            ]);

            if (verifyIl)
            {
                IlVerifier.Verify(assemblyPath, additionalReferences: new[] { contractsPath });
            }

            AssertLoadsWithReifiedLambdaSignatures(
                assemblyPath,
                contractsPath,
                expectedSourceTypeName);
            return Run(assemblyPath, directory);
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static void AssertLoadsWithReifiedLambdaSignatures(
        string assemblyPath,
        string contractsPath,
        string expectedSourceTypeName)
    {
        var loadContext = new AssemblyLoadContext(
            "Issue2918_" + Guid.NewGuid().ToString("N"),
            isCollectible: true);
        try
        {
            var contracts = loadContext.LoadFromAssemblyPath(contractsPath);
            loadContext.Resolving += (_, name) =>
                name.Name == contracts.GetName().Name ? contracts : null;
            Assert.NotEmpty(contracts.GetTypes());

            var assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
            var types = assembly.GetTypes();
            Assert.NotEmpty(types);
            var lambdas = types
                .SelectMany(type => type.GetMethods(
                    BindingFlags.Public
                    | BindingFlags.NonPublic
                    | BindingFlags.Static
                    | BindingFlags.Instance))
                .Where(method =>
                    method.Name.Contains("<lambda", StringComparison.Ordinal)
                    || method.DeclaringType?.FullName?.Contains("<closure", StringComparison.Ordinal) == true)
                .ToArray();
            Assert.NotEmpty(lambdas);

            var signatures = string.Join(
                "\n",
                lambdas.Select(method =>
                    method.ReturnType + "("
                    + string.Join(",", method.GetParameters().Select(parameter => parameter.ParameterType))
                    + ")"));
            Assert.Contains(expectedSourceTypeName, signatures, StringComparison.Ordinal);
            Assert.DoesNotContain(
                lambdas,
                method =>
                    ContainsObjectGenericArgument(method.ReturnType)
                    || method.GetParameters().Any(parameter =>
                        ContainsObjectGenericArgument(parameter.ParameterType)));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static bool ContainsObjectGenericArgument(Type type)
    {
        if (type == typeof(object))
        {
            return true;
        }

        return type.IsArray
            ? ContainsObjectGenericArgument(type.GetElementType())
            : type.IsGenericType
                && type.GetGenericArguments().Any(ContainsObjectGenericArgument);
    }

    private static string Run(string assemblyPath, string directory)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        if (!File.Exists(runtimeConfigPath))
        {
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);
        }

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfigPath);
        startInfo.ArgumentList.Add(assemblyPath);

        var (exitCode, stdout, stderr) = IlVerifier.RunProcess(startInfo, assemblyPath, 30_000);
        Assert.True(
            exitCode == 0,
            $"dotnet exec exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static void Compile(string[] args)
    {
        var (exitCode, output) = RunCompiler(args);
        Assert.True(exitCode == 0, $"gsc failed:\n{output}");
    }

    private static string CompileExpectingFailure(string source)
    {
        var directory = CreateDirectory("Issue2918_Rejected_");
        try
        {
            var contractsPath = Path.Combine(directory, "Issue2918Contracts.dll");
            CompileCSharp(Contracts, contractsPath, "Issue2918Contracts");

            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            var (exitCode, output) = RunCompiler(
            [
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/r:" + contractsPath,
                sourcePath,
            ]);

            Assert.NotEqual(0, exitCode);
            return output;
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static (int ExitCode, string Output) RunCompiler(string[] args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int exitCode;
        try
        {
            exitCode = Program.Main(args);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (exitCode, stdoutWriter.ToString() + stderrWriter.ToString());
    }

    private static void CompileCSharp(
        string source,
        string outputPath,
        string assemblyName,
        params string[] additionalReferences)
    {
        var syntaxTree = CSharpSyntaxTree.ParseText(source);
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Concat(additionalReferences.Select(path =>
                (MetadataReference)MetadataReference.CreateFromFile(path)));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string CreateDirectory(string prefix)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            prefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void DeleteDirectory(string directory)
    {
        for (var attempt = 0; attempt < 3 && Directory.Exists(directory); attempt++)
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException) when (attempt < 2)
            {
                System.Threading.Thread.Sleep(50);
            }
            catch (UnauthorizedAccessException) when (attempt < 2)
            {
                System.Threading.Thread.Sleep(50);
            }
        }

        Assert.False(Directory.Exists(directory), $"Failed to delete '{directory}'.");
    }
}
