// <copyright file="Issue4776CopyProvenanceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection
import System.Text
import GSharp.Core.Tests
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis

class Issue4776CopyProvenanceEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedPlatformValueContainer_WidensOnlyToNullableContracts(useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Platform.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`#nullable disable
using System.Collections.Generic;
namespace CopyPlatform5413;
public record struct S<T>(T Value) {
    public readonly object Anchor = Api.Construct();
}
public struct Plain<T> { public T Value; }
public static class Api {
    public static readonly object Marker = new();
    public static int Calls, Constructions;
    public static object Construct() { Constructions++; return Marker; }
    public static S<string> Create() { Calls++; return new(null); }
    public static Plain<string> Plain() { Calls++; return new() { Value = null }; }
    public static S<S<string>> Nested() { Calls++; return new(new(null)); }
    public static S<List<string>> NestedReference() { Calls++; return new(new() { null }); }
    public static S<int> Value() => new(42);
    public static S<int?> Optional() => new(null);
    public static S<string>? Absent() => null;
    public static S<string>? Present() => Create();
#nullable enable
    public static S<string> Required() => new("required");
}`, "Platform", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        const source = `package PlatformApi5413
import System.Collections.Generic
import CopyPlatform5413
public class Exports {
    shared {
        public func Direct() S[string?] -> Api.Create()
        public func Local() S[string?] {
            let value S[string?] = Api.Create()
            return value
        }
        private func Receive(value S[string?]) S[string?] -> value
        public func Argument() S[string?] -> Receive(Api.Create())
        public func Lift() S[string?]? -> Api.Create()
        public func Present() S[string?]? -> Api.Present()
        public func Absent() S[string?]? -> Api.Absent()
        public func Plain() Plain[string?] -> Api.Plain()
        public func Nested() S[S[string?]] -> Api.Nested()
        public func NestedReference() S[List[string?]?] -> Api.NestedReference()
        public func Required() S[string] -> Api.Required()
        public func Value() S[int32] -> Api.Value()
        public func Optional() S[int32?] -> Api.Optional()
    }
}`
        let apiReference = Path.Combine(fixture.Directory, "Widening.ref.dll")
        let arguments = []string{"/assemblyname:Widening", "/r:" + selected, "/refout:" + apiReference}.Concat(
            runtimeReferences.Select((path string) -> "/r:" + path)
        )
            .ToArray()
        let api = fixture.Compile(source, "Widening", executable: false, arguments)
        let firstImage = File.ReadAllBytes(api)
        let firstReference = File.ReadAllBytes(apiReference)
        let _ = fixture.Compile(source, "Widening", executable: false, arguments)
        Assert.Equal(firstImage, File.ReadAllBytes(api))
        Assert.Equal(firstReference, File.ReadAllBytes(apiReference))
        let caller = fixture.CompileCSharp(`#nullable enable
using System;
using System.Reflection;
using CopyPlatform5413;
using PlatformApi5413;
public static class Probe {
    public static string Run() {
        foreach (var value in new[] { Exports.Direct(), Exports.Local(), Exports.Argument() })
            if (value.Value != null || !ReferenceEquals(value.Anchor, Api.Marker))
                throw new Exception("Widening lost null or storage.");
        var lifted = Exports.Lift();
        var present = Exports.Present();
        var nested = Exports.Nested();
        var nestedReference = Exports.NestedReference();
        if (!lifted.HasValue || lifted.Value.Value != null || !present.HasValue || present.Value.Value != null
            || !ReferenceEquals(lifted.Value.Anchor, Api.Marker) || !ReferenceEquals(present.Value.Anchor, Api.Marker)
            || Exports.Absent().HasValue || Exports.Plain().Value != null
            || nested.Value.Value != null || !ReferenceEquals(nested.Value.Anchor, Api.Marker)
            || !ReferenceEquals(nested.Anchor, Api.Marker)
            || nestedReference.Value == null || nestedReference.Value.Count != 1 || nestedReference.Value[0] != null
            || Api.Calls != 8 || Api.Constructions != 8)
            throw new Exception("Widening changed optionality, nested storage or evaluation count.");
        if (Exports.Required().Value != "required" || Exports.Value().Value != 42 || Exports.Optional().Value != null)
            throw new Exception("Non-null or value-type contract changed.");
        var context = new NullabilityInfoContext();
        foreach (var name in new[] { "Direct", "Local", "Argument", "Plain" }) {
            var method = typeof(Exports).GetMethod(name)!;
            if (context.Create(method.ReturnParameter).GenericTypeArguments[0].ReadState != NullabilityState.Nullable)
                throw new Exception("Nullable argument metadata lost: " + name);
        }
        var required = context.Create(typeof(Exports).GetMethod("Required")!.ReturnParameter);
        var nestedInfo = context.Create(typeof(Exports).GetMethod("Nested")!.ReturnParameter);
        var nestedReferenceInfo = context.Create(typeof(Exports).GetMethod("NestedReference")!.ReturnParameter);
        if (required.GenericTypeArguments[0].ReadState != NullabilityState.NotNull
            || nestedInfo.GenericTypeArguments[0].GenericTypeArguments[0].ReadState != NullabilityState.Nullable
            || nestedReferenceInfo.GenericTypeArguments[0].ReadState != NullabilityState.Nullable
            || nestedReferenceInfo.GenericTypeArguments[0].GenericTypeArguments[0].ReadState != NullabilityState.Nullable)
            throw new Exception("Nested metadata was erased.");
        return "null|storage|once|optional|nested|metadata";
    }
}`, "PlatformCaller", contract, apiReference)
        for image in[]string{contract, api, caller} {
            var report = string.Empty
            IlVerifier.Verify(
                image,
                runtimeReferences.Concat([]string{contract, api}),
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal(
            "null|storage|once|optional|nested|metadata",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
        for (target, expression) in[](string, string){
            ("S[string]", "Api.Create()"),
            ("S[object?]", "Api.Create()"),
            ("S[S[string]]", "Api.Nested()"),
            ("S[List[string]]", "Api.NestedReference()"),
            ("S[List[string]?]", "Api.NestedReference()"),
            ("S[string?]", "Api.Required()"),
            ("S[int32]", "Api.Optional()"),
            ("S[int32?]", "Api.Value()"),
            ("S[string?]", "Api.Present()")
        } {
            let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
            let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
            let (code, output) = fixture.TryCompile(
                "import System.Collections.Generic\nimport CopyPlatform5413\npublic func Rejected() " +
                    target +
                    " -> " +
                    expression +
                    "\n",
                "Rejected",
                executable: false,
                []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                    runtimeReferences.Select((path string) -> "/r:" + path)
                )
                    .ToArray()
            )
            let start = 28 + target.Length
            let end = start + expression.Length
            Assert.NotEqual(0, code)
            Assert.Contains("Rejected.gs(3,$start,3,$end): error GS0155:", output, StringComparison.Ordinal)
            Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
            Assert.False(File.Exists(rejectedReference))
            Assert.False(File.Exists(pdb))
        }
        for modifier in[]string{"ref", "out"} {
            let rejectedReference = Path.Combine(fixture.Directory, "ByRef.ref.dll")
            let pdb = Path.Combine(fixture.Directory, "ByRef.pdb")
            let (code, output) = fixture.TryCompile(
                "import CopyPlatform5413\nfunc Receive(" +
                    modifier +
                    " value S[int32]) { value = default }\n" +
                    "public func Rejected() {\nvar value = Api.Optional()\nReceive(" +
                    modifier +
                    " value)\n}",
                "ByRef",
                executable: false,
                []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                    runtimeReferences.Select((path string) -> "/r:" + path)
                )
                    .ToArray()
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("ByRef.gs(5,9,5,18): error GS0154:", StringComparison.Ordinal), output)
            Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "ByRef.dll")))
            Assert.False(File.Exists(rejectedReference))
            Assert.False(File.Exists(pdb))
        }
    }

    private const ReviewContract5413 string = `#nullable enable
using System;
using System.Collections.Generic;
using RequiredList = System.Collections.Generic.List<string>;
namespace Review5413;
public record struct S<T>(T Value);
public record struct Pair<T, U>(T First, U Second);
public static class Api {
#nullable disable
    public static Pair<string,
#nullable enable
        string?> Mixed() => new(null, null);
#nullable disable
    public static S<RequiredList> Nested() => new(new() { "required" });
    public static List<Tuple<int, int>> ReferenceTuples() => new() { Tuple.Create(1, 2) };
    public static List<ValueTuple<int, int>> ValueTuples() => new() { (3, 4) };
}`

    @Theory
    @InlineData(false, "Pair[string?, string]", "Api.Mixed()")
    @InlineData(true, "Pair[string?, string]", "Api.Mixed()")
    @InlineData(false, "S[List[string?]?]", "Api.Nested()")
    @InlineData(true, "S[List[string?]?]", "Api.Nested()")
    func ImportedPlatformValueContainer_RejectsContractChanges(useReference bool, target string, expression string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Contracts.ref.dll")
        let contract = fixture.CompileCSharpWithReference(ReviewContract5413, "Contracts", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
        let (code, output) = fixture.TryCompile(
            "import System.Collections.Generic\nimport Review5413\npublic func Rejected() " +
                target +
                " -> " +
                expression +
                "\n",
            "Rejected",
            executable: false,
            []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                runtimeReferences.Select((path string) -> "/r:" + path)
            )
                .ToArray()
        )
        let start = 28 + target.Length
        let end = start + expression.Length
        Assert.NotEqual(0, code)
        Assert.Contains("Rejected.gs(3,$start,3,$end): error GS0155:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        Assert.False(File.Exists(pdb))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ImportedGenericStorage_PreservesClrTupleFamilies(useReference bool, isOut bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Contracts.ref.dll")
        let contract = fixture.CompileCSharpWithReference(ReviewContract5413, "Contracts", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        let modifier = if isOut {
            "out"
        } else {
            "ref"
        }
        let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
        let (code, output) = fixture.TryCompile(
            "import System.Collections.Generic\nimport Review5413\nfunc Receive(" +
                modifier +
                " value List[(int32, int32)]) { value = default }\npublic func Rejected() {\n" +
                "var value = Api.ReferenceTuples()\nReceive(" +
                modifier +
                " value)\n}\n",
            "Rejected",
            executable: false,
            []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                runtimeReferences.Select((path string) -> "/r:" + path)
            )
                .ToArray()
        )
        Assert.NotEqual(0, code)
        Assert.Contains("Rejected.gs(6,9,6,18): error GS0154:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        Assert.False(File.Exists(pdb))
        let apiReference = Path.Combine(fixture.Directory, "Storage.ref.dll")
        let api = fixture.Compile(`package Storage5413
import System.Collections.Generic
import Review5413
public class Exports {
    shared {
        private func Keep(ref value List[(int32, int32)]) List[(int32, int32)] -> value
        private func Reset(out value List[(int32, int32)]) { value = Api.ValueTuples() }
        public func Mixed() Pair[string?, string?] -> Api.Mixed()
        public func Nested() S[List[string]?] -> Api.Nested()
        public func Run() int32 {
            var value = Api.ValueTuples()
            let kept = Keep(ref value)
            Reset(out value)
            return kept[0].Item1 + value[0].Item2
        }
    }
}`, "Storage", executable: false, []string{"/assemblyname:Storage", "/r:" + selected, "/refout:" + apiReference}
                .Concat(runtimeReferences.Select((path string) -> "/r:" + path)).ToArray())
        let caller = fixture.CompileCSharp(`using System;
using Storage5413;
public static class Probe {
    public static int Run() {
        var mixed = Exports.Mixed();
        var nested = Exports.Nested();
        if (mixed.First != null || mixed.Second != null || nested.Value == null || nested.Value[0] != "required")
            throw new Exception("Matching argument contracts or storage changed.");
        return Exports.Run();
    }
}`, "Caller", contract, apiReference)
        for image in[]string{contract, api, caller} {
            var report = string.Empty
            IlVerifier.Verify(
                image,
                runtimeReferences.Concat([]string{contract, api}),
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal(7, assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func NullableValueTupleSpelling_LiftsGenericAndClosedValues() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Lifts.ref.dll")
        let api = fixture.Compile(`package TupleLifts5413
public class Exports {
    shared {
        public func Lift[T](value (int32, T)) System.ValueTuple[int32, T]? -> value
        public func Closed(value (int32, int32)) System.ValueTuple[int32, int32]? -> value
    }
}`, "Lifts", executable: false, []string{"/assemblyname:Lifts", "/refout:" + reference}
                .Concat(runtimeReferences.Select((path string) -> "/r:" + path)).ToArray())
        let caller = fixture.CompileCSharp(`using System;
using TupleLifts5413;
public static class Probe {
    public static string Run() {
        var reference = Exports.Lift<string>((17, "open"));
        var value = Exports.Lift<int>((19, 23));
        var closed = Exports.Closed((29, 31));
        if (!reference.HasValue || !value.HasValue || !closed.HasValue)
            throw new Exception("Nullable construction lost the value.");
        return $"{reference.Value.Item1}|{reference.Value.Item2}|{value.Value.Item1}|{value.Value.Item2}|{closed.Value.Item1}|{closed.Value.Item2}";
    }
}`, "Caller", reference)
        for image in[]string{api, caller} {
            var report = string.Empty
            IlVerifier.Verify(
                image,
                runtimeReferences.Concat([]string{api}),
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }
        let assemblies = EmittedFixture.LoadTogether(api, caller)
        Assert.Equal("17|open|19|23|29|31", assemblies[1].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    private const MixedReferenceContract5413 string = `#nullable enable
using System;
using System.Collections.Generic;
namespace ReviewMixed5413;
public class C<T, U> {
    public T First;
    public U Second;
    public C(T first, U second) { First = first; Second = second; }
}
public static class Api {
    public static C<
#nullable disable
        string,
#nullable enable
        string?> Mixed() => new(null, null);
    public static C<string?,
#nullable disable
        string
#nullable enable
        > Reversed() => new(null, null);
    public static C<
#nullable disable
        string,
#nullable enable
        List<string?>> Nested() => new(null, new() { null });
    public static C<C<
#nullable disable
        string,
#nullable enable
        string?>, int> Recursive() => new(Mixed(), 42);
    public static C<
#nullable disable
        string,
#nullable enable
        int?> Optional() => new(null, null);
    public static C<
#nullable disable
        string,
#nullable enable
        C<int?, string?>> Deep() => new(null, new(null, null));
    public static C<
#nullable disable
        string,
#nullable enable
        C<int?, int>> DeepOptional() => new(null, new(null, 42));
    public static C<
#nullable disable
        string,
#nullable enable
        C<List<Tuple<int, int>>, int>> DeepStorage() => new(null, new(new() { Tuple.Create(1, 2) }, 42));
    public static C<
#nullable disable
        string,
#nullable enable
        List<Tuple<int, int>>> Storage() => new(null, new() { Tuple.Create(1, 2) });
    public static int Consume(C<string, string> value) => value.First.Length + value.Second.Length;
}`

    @Theory
    @InlineData(false, "C[string, string]", "Api.Mixed()")
    @InlineData(true, "C[string, string]", "Api.Mixed()")
    @InlineData(false, "C[string?, string]", "Api.Mixed()")
    @InlineData(true, "C[string?, string]", "Api.Mixed()")
    @InlineData(false, "C[string, string]", "Api.Reversed()")
    @InlineData(true, "C[string, string]", "Api.Reversed()")
    @InlineData(false, "C[string, List[string]]", "Api.Nested()")
    @InlineData(true, "C[string, List[string]]", "Api.Nested()")
    @InlineData(false, "C[string?, List[string]]", "Api.Nested()")
    @InlineData(true, "C[string?, List[string]]", "Api.Nested()")
    @InlineData(false, "C[C[string, string], int32]", "Api.Recursive()")
    @InlineData(true, "C[C[string, string], int32]", "Api.Recursive()")
    @InlineData(false, "C[string, int32]", "Api.Optional()")
    @InlineData(true, "C[string, int32]", "Api.Optional()")
    @InlineData(false, "C[string?, int32]", "Api.Optional()")
    @InlineData(true, "C[string?, int32]", "Api.Optional()")
    @InlineData(false, "C[string?, C[int32, string]]", "Api.Deep()")
    @InlineData(true, "C[string?, C[int32, string]]", "Api.Deep()")
    @InlineData(false, "C[string?, C[int32, int32]]", "Api.DeepOptional()")
    @InlineData(true, "C[string?, C[int32, int32]]", "Api.DeepOptional()")
    @InlineData(false, "C[string?, C[List[(int32, int32)], int32]]", "Api.DeepStorage()")
    @InlineData(true, "C[string?, C[List[(int32, int32)], int32]]", "Api.DeepStorage()")
    @InlineData(false, "C[string, List[(int32, int32)]]", "Api.Storage()")
    @InlineData(true, "C[string, List[(int32, int32)]]", "Api.Storage()")
    @InlineData(false, "C[string?, List[(int32, int32)]]", "Api.Storage()")
    @InlineData(true, "C[string?, List[(int32, int32)]]", "Api.Storage()")
    func ImportedPlatformReferenceContainer_RejectsMixedContracts(useReference bool, target string, expression string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Contracts.ref.dll")
        let contract = fixture.CompileCSharpWithReference(MixedReferenceContract5413, "Contracts", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
        let (code, output) = fixture.TryCompile(
            "import System.Collections.Generic\nimport ReviewMixed5413\npublic func Rejected() " +
                target +
                " -> " +
                expression +
                "\n",
            "Rejected",
            executable: false,
            []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                runtimeReferences.Select((path string) -> "/r:" + path)
            )
                .ToArray()
        )
        let start = 28 + target.Length
        let end = start + expression.Length
        Assert.NotEqual(0, code)
        Assert.Contains("Rejected.gs(3,$start,3,$end): error GS0155:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        Assert.False(File.Exists(pdb))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedPlatformReferenceContainer_RejectsMixedClrArguments(useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Contracts.ref.dll")
        let contract = fixture.CompileCSharpWithReference(MixedReferenceContract5413, "Contracts", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
        let (code, output) = fixture.TryCompile(
            "import ReviewMixed5413\npublic func Rejected() int32 -> Api.Consume(Api.Mixed())\n",
            "Rejected",
            executable: false,
            []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                runtimeReferences.Select((path string) -> "/r:" + path)
            )
                .ToArray()
        )
        Assert.NotEqual(0, code)
        Assert.Contains("Rejected.gs(2,45,2,56): error GS0154:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        Assert.False(File.Exists(pdb))
    }

    private const PlatformContextContract5413 string = `#nullable enable
using System;
using System.Collections.Generic;
namespace Context5413;
public record struct S<T>(T Value);
public class Box<T, U>(T first, U second) { public T First = first; public U Second = second; }
public interface IView<out T, out U> { T First { get; } U Second { get; } }
public interface IWrite<in T, in U> { void Put(T first, U second); }
public class ViewImpl<T, U>(T first, U second) : IView<T, U> {
    public T First => first;
    public U Second => second;
}
public class WriteImpl<T, U> : IWrite<T, U> {
    public void Put(T first, U second) { Api.Writes++; }
}
public static class Api {
    public static int Calls, Writes;
#nullable disable
    public static string Get() { Calls++; return null; }
#nullable enable
    public static IView<
#nullable disable
        string,
#nullable enable
        string> View() => new ViewImpl<string, string>(Get(), "view");
    public static IWrite<string?,
#nullable disable
        string
#nullable enable
        > Sink() => new WriteImpl<string?, string>();
    public static Box<
#nullable disable
        string,
#nullable enable
        string> Invariant() => new(Get(), "box");
    public static S<List<
#nullable disable
        string
#nullable enable
        >?> NullList() => new(null);
    public static S<S<List<
#nullable disable
        string
#nullable enable
        >?>> NestedNullList() => new(NullList());
    public static S<(
#nullable disable
        string,
#nullable enable
        string)> AliasedTuple() => new((Get(), "tuple"));
    public static Box<IView<
#nullable disable
        string,
#nullable enable
        string>, int> NestedInvariant() => new(View(), 42);
    public static IView<List<
#nullable disable
        string
#nullable enable
        >?, string> NullableView() => new ViewImpl<List<string>?, string>(null, "view");
    public static IView<int?,
#nullable disable
        string> OptionalView() => new ViewImpl<int?, string>(null, null);
    public static IView<string,
#nullable enable
        List<Tuple<int, int>>> TupleView() =>
        new ViewImpl<string, List<Tuple<int, int>>>(null!, new() { Tuple.Create(17, 19) });
}`

    @Theory
    @InlineData(false, "stored")
    @InlineData(true, "stored")
    @InlineData(false, "view")
    @InlineData(true, "view")
    @InlineData(false, "sink")
    @InlineData(true, "sink")
    func ImportedPlatformValueConversion_UsesStructuralAndVariantContexts(useReference bool, context string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Contexts.ref.dll")
        let contract = fixture.CompileCSharpWithReference(PlatformContextContract5413, "Contexts", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        let body = if context == "stored" {
            "public func Lift() (string?, string?) {\nlet pair = (Api.Get(), \"x\")\nreturn pair\n}"
        } else if context == "view" {
            "public func Lift() IView[string?, string?] -> Api.View()"
        } else {
            "public func Lift() IWrite[string, string] -> Api.Sink()"
        }
        let apiReference = Path.Combine(fixture.Directory, "Values.ref.dll")
        let api = fixture.Compile(
            "package ValueContexts5413\nimport System.Collections.Generic\nimport Context5413\n" +
                "public class Exports { shared {\n" +
                body +
                "\npublic func NullableList() S[List[string?]?] -> Api.NullList()\n" +
                "public func NestedNullableList() S[S[List[string?]?]] -> Api.NestedNullList()\n} }\n",
            "Values",
            executable: false,
            []string{"/assemblyname:Values", "/r:" + selected, "/refout:" + apiReference}.Concat(
                runtimeReferences.Select((path string) -> "/r:" + path)
            )
                .ToArray()
        )
        let assertion = if context == "stored" {
            `if (value.Item1 != null || value.Item2 != "x" || Api.Calls != 1) throw new Exception("Stored tuple changed.");
return $"{value.Item1 == null}|{value.Item2}|{Api.Calls}";`
        } else if context == "view" {
            `if (value.First != null || value.Second != "view" || Api.Calls != 1) throw new Exception("Covariant view changed.");
return $"{value.First == null}|{value.Second}|{Api.Calls}";`
        } else {
            `value.Put("first", "second");
if (Api.Writes != 1 || Api.Calls != 0) throw new Exception("Contravariant view changed.");
return $"{Api.Writes}|{Api.Calls}";`
        }
        let caller = fixture.CompileCSharp(
            "using System;\nusing Context5413;\nusing ValueContexts5413;\npublic static class Probe {\n" +
                "public static string Run() {\n" +
                "if (Exports.NullableList().Value != null || Exports.NestedNullableList().Value.Value != null) " +
                "throw new Exception(\"Nullable list changed.\");\nvar value = Exports.Lift();\n" +
                assertion +
                "\n} }",
            "Caller",
            contract,
            apiReference
        )
        for image in[]string{contract, api, caller} {
            var report = string.Empty
            IlVerifier.Verify(
                image,
                runtimeReferences.Concat([]string{contract, api}),
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        let expected = if context == "stored" {
            "True|x|1"
        } else if context == "view" {
            "True|view|1"
        } else {
            "1|0"
        }
        Assert.Equal(expected, assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
        if context == "view" {
            let targets = []string{
                "Box[string?, string?]",
                "S[(string?, string?)]",
                "Box[IView[string?, string?], int32]",
                "IView[string, string?]",
                "IView[List[string?], string?]",
                "IView[int32, string?]",
                "IView[string?, List[(int32, int32)]]"
            }
            let expressions = []string{
                "Api.Invariant()",
                "Api.AliasedTuple()",
                "Api.NestedInvariant()",
                "Api.View()",
                "Api.NullableView()",
                "Api.OptionalView()",
                "Api.TupleView()"
            }
            for var i = 0; i < targets.Length; i++ {
                let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
                let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
                let (code, output) = fixture.TryCompile(
                    "import System.Collections.Generic\nimport Context5413\npublic func Rejected() " +
                        targets[i] +
                        " -> " +
                        expressions[i] +
                        "\n",
                    "Rejected",
                    executable: false,
                    []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                        runtimeReferences.Select((path string) -> "/r:" + path)
                    )
                        .ToArray()
                )
                let start = 28 + targets[i].Length
                let end = start + expressions[i].Length
                Assert.NotEqual(0, code)
                Assert.Contains("Rejected.gs(3,$start,3,$end): error GS0155:", output, StringComparison.Ordinal)
                Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
                Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
                Assert.False(File.Exists(rejectedReference))
                Assert.False(File.Exists(pdb))
            }
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ImportedPlatformValueContainer_RejectsNullableNodesWithPlatformDescendants(useReference bool, nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Contexts.ref.dll")
        let contract = fixture.CompileCSharpWithReference(PlatformContextContract5413, "Contexts", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        let target = if nested {
            "S[S[List[string?]]]"
        } else {
            "S[List[string?]]"
        }
        let expression = if nested {
            "Api.NestedNullList()"
        } else {
            "Api.NullList()"
        }
        let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
        let (code, output) = fixture.TryCompile(
            "import System.Collections.Generic\nimport Context5413\npublic func Rejected() " +
                target +
                " -> " +
                expression +
                "\n",
            "Rejected",
            executable: false,
            []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                runtimeReferences.Select((path string) -> "/r:" + path)
            )
                .ToArray()
        )
        let start = 28 + target.Length
        let end = start + expression.Length
        Assert.NotEqual(0, code)
        Assert.Contains("Rejected.gs(3,$start,3,$end): error GS0155:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        Assert.False(File.Exists(pdb))
    }

    private const PlatformOuterContract5413 string = `#nullable enable
namespace ContextOuter5413;
public interface IView<out T, out U> { T First { get; } U Second { get; } }
public class ViewImpl<T, U>(T first, U second) : IView<T, U> {
    public T First => first;
    public U Second => second;
}
public class Box<T, U>(T first, U second) { public T First = first; public U Second = second; }
public static class Maker<T> where T : class {
    public static IView<
#nullable disable
        string,
#nullable enable
        T> Create(T value) {
        Api.Calls++;
        return new ViewImpl<string, T>(null!, value);
    }
    public static Box<
#nullable disable
        string,
#nullable enable
        T> Invariant(T value) => new(null!, value);
}
public static class Api {
    public static int Calls;
#nullable disable
    public static string Get() { Calls++; return null; }
    public static IView<string,
#nullable enable
        string
#nullable disable
        > Outer(bool absent) {
        Calls++;
        return absent ? null : new ViewImpl<string, string>(null, "outer");
    }
}`

    @Theory
    @InlineData(false, "outer")
    @InlineData(true, "outer")
    @InlineData(false, "nullable-outer")
    @InlineData(true, "nullable-outer")
    @InlineData(false, "local-view")
    @InlineData(true, "local-view")
    @InlineData(false, "nullable-tuple")
    @InlineData(true, "nullable-tuple")
    func ImportedPlatformViewContext_PreservesOuterChecksAndSymbolicReferences(useReference bool, context string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Outer.ref.dll")
        let contract = fixture.CompileCSharpWithReference(PlatformOuterContract5413, "Outer", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        let body = if context == "outer" {
            "public func Lift(absent bool) IView[string?, string?] -> Api.Outer(absent)"
        } else if context == "nullable-outer" {
            "public func Lift(absent bool) IView[string?, string?]? -> Api.Outer(absent)"
        } else if context == "local-view" {
            "public func Lift(value C) IView[string?, C?] {\nlet view = Maker[C].Create(value)\nreturn view\n}"
        } else {
            `public func Lift(value C) (string?, C?)? {
let pair = (Api.Get(), value)
return pair
}
public func Stored(value C) (string?, C?) {
let pair = (Api.Get(), value)
return pair
}
public func Imported(value C) System.ValueTuple[string?, C?]? {
let pair = (Api.Get(), value)
return pair
}`
        }
        let apiReference = Path.Combine(fixture.Directory, "Views.ref.dll")
        let api = fixture.Compile(
            "package OuterViews5413\nimport ContextOuter5413\npublic class C {}\npublic class Exports { shared {\n" +
                body +
                "\n} }\n",
            "Views",
            executable: false,
            []string{"/assemblyname:Views", "/r:" + selected, "/refout:" + apiReference}.Concat(
                runtimeReferences.Select((path string) -> "/r:" + path)
            )
                .ToArray()
        )
        let assertion = if context == "outer" {
            `var value = Exports.Lift(false);
if (value.First != null || value.Second != "outer") throw new Exception("View changed.");
bool checkedNull = false;
try {
    Exports.Lift(true);
    throw new Exception("The outer null crossed a non-null boundary.");
} catch (NullReferenceException error) {
    if (!error.Message.Contains("'Outer(absent)' was nil") || !error.Message.Contains("Views.gs:5"))
        throw new Exception("The outer check lost its origin.", error);
    checkedNull = true;
}
if (Api.Calls != 2) throw new Exception("The producer was evaluated twice.");
return $"{value.First == null}|{value.Second}|{checkedNull}|{Api.Calls}";`
        } else if context == "nullable-outer" {
            `var value = Exports.Lift(false);
var absent = Exports.Lift(true);
if (value == null || value.First != null || value.Second != "outer" || absent != null || Api.Calls != 2)
    throw new Exception("The nullable outer view changed.");
return $"{value.First == null}|{value.Second}|{absent == null}|{Api.Calls}";`
        } else if context == "local-view" {
            `var item = new C();
var value = Exports.Lift(item);
if (value.First != null || !ReferenceEquals(value.Second, item) || Api.Calls != 1)
    throw new Exception("The symbolic class reference changed.");
return $"{value.First == null}|{ReferenceEquals(value.Second, item)}|{Api.Calls}";`
        } else {
            `var item = new C();
var lifted = Exports.Lift(item);
var stored = Exports.Stored(item);
var imported = Exports.Imported(item);
if (!lifted.HasValue || !imported.HasValue || lifted.Value.Item1 != null || stored.Item1 != null ||
    imported.Value.Item1 != null || !ReferenceEquals(lifted.Value.Item2, item) ||
    !ReferenceEquals(stored.Item2, item) || !ReferenceEquals(imported.Value.Item2, item) || Api.Calls != 3)
    throw new Exception("The tuple reference or Nullable storage changed.");
return $"{lifted.HasValue}|{lifted.Value.Item1 == null}|{ReferenceEquals(lifted.Value.Item2, item)}|{Api.Calls}";`
        }
        let caller = fixture.CompileCSharp(
            "using System;\nusing ContextOuter5413;\nusing OuterViews5413;\npublic static class Probe {\n" +
                "public static string Run() {\n" +
                assertion +
                "\n} }",
            "Caller",
            contract,
            apiReference
        )
        for image in[]string{contract, api, caller} {
            var report = string.Empty
            IlVerifier.Verify(
                image,
                runtimeReferences.Concat([]string{contract, api}),
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        let expected = if context == "outer" || context == "nullable-outer" {
            "True|outer|True|2"
        } else if context == "local-view" {
            "True|True|1"
        } else {
            "True|True|True|3"
        }
        Assert.Equal(expected, assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
        let rejectedLine = if context == "outer" || context == "nullable-outer" {
            "public func Rejected() IView[string, string?] -> Api.Outer(false)"
        } else if context == "local-view" {
            "public func Rejected() Box[string?, C?] -> Maker[C].Invariant(C())"
        } else {
            "public func Rejected(value (string?, C?)?) (string?, C?) -> value"
        }
        let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
        let (code, output) = fixture.TryCompile(
            "package OuterReject5413\nimport ContextOuter5413\npublic class C {}\n" + rejectedLine + "\n",
            "Rejected",
            executable: false,
            []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                runtimeReferences.Select((path string) -> "/r:" + path)
            )
                .ToArray()
        )
        let start = rejectedLine.IndexOf("->", StringComparison.Ordinal) + 4
        let end = rejectedLine.Length + 1
        Assert.NotEqual(0, code)
        let diagnostic = if context == "local-view" {
            "GS0490"
        } else {
            "GS0155"
        }
        Assert.Contains("Rejected.gs(4,$start,4,$end): error $diagnostic:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        Assert.False(File.Exists(pdb))
    }

    private const PlatformArrayContract5413 string = `#nullable enable
namespace ContextArrays5413;
public interface IView<out T, out U> { T First { get; } U Second { get; } }
public interface ISink<out T, in U> { T First { get; } void Put(U value); }
public class ViewImpl<T, U>(T first, U second) : IView<T, U> {
    public T First => first;
    public U Second => second;
}
public class SinkImpl<T, U>(T first) : ISink<T, U> {
    public T First => first;
    public void Put(U value) { Api.Puts++; Api.Last = value; }
}
public static class Producer<U> where U : class {
    public static IView<
#nullable disable
        string,
#nullable enable
        U> View(U value) { Api.Calls++; return new ViewImpl<string, U>(null!, value); }
    public static ISink<
#nullable disable
        string,
#nullable enable
        U> Sink() { Api.Calls++; return new SinkImpl<string, U>(null!); }
    public static IView<string, U> OrdinaryView(U value) {
        Api.Calls++; return new ViewImpl<string, U>("ordinary", value);
    }
    public static ISink<string, U> OrdinarySink() {
        Api.Calls++; return new SinkImpl<string, U>("ordinary");
    }
}
public static class Api {
    public static int Calls, Puts;
    public static object? Last;
    public static IView<
#nullable disable
        string,
#nullable enable
        int[]> MetadataView() {
        Api.Calls++; return new ViewImpl<string, int[]>(null!, new[] { 10, 20, 30 });
    }
    public static ISink<
#nullable disable
        string,
#nullable enable
        int[]> MetadataSink() {
        Api.Calls++; return new SinkImpl<string, int[]>(null!);
    }
}`

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ImportedPlatformVariance_PreservesKnownArrayShapes(useReference bool, contravariant bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "Arrays.ref.dll")
        let contract = fixture.CompileCSharpWithReference(PlatformArrayContract5413, "Arrays", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        let shape = if contravariant {
            "ISink"
        } else {
            "IView"
        }
        for element in[]string{"int32", "C"} {
            let sourceArgument = if contravariant {
                "[]$element"
            } else {
                "[3]$element"
            }
            let targetArgument = if contravariant {
                "[3]$element"
            } else {
                "[]$element"
            }
            let values = if element == "C" {
                "C(), C(), C()"
            } else {
                "10, 20, 30"
            }
            let make = if contravariant {
                "Sink()"
            } else {
                "View($sourceArgument{$values})"
            }
            let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
            let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
            let (code, output) = fixture.TryCompile(
                "package ArrayReject5413\nimport ContextArrays5413\npublic class C {}\n" +
                    "public func Rejected() $shape[string?, $targetArgument] {\n" +
                    "let value = Producer[$sourceArgument].$make\nreturn value\n}\n",
                "Rejected",
                executable: false,
                []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                    runtimeReferences.Select((path string) -> "/r:" + path)
                )
                    .ToArray()
            )
            Assert.NotEqual(0, code)
            Assert.Contains("Rejected.gs(6,8,6,13): error GS0155:", output, StringComparison.Ordinal)
            Assert.Contains("$shape[string!, $sourceArgument]", output, StringComparison.Ordinal)
            Assert.Contains("$shape[string?, $targetArgument]", output, StringComparison.Ordinal)
            Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
            Assert.False(File.Exists(rejectedReference))
            Assert.False(File.Exists(pdb))
        }
        let body = if contravariant {
            `public func Match(value [3]int32) ISink[string?, [3]int32] -> Producer[[3]int32].Sink()
public func Slice(value []int32) ISink[string?, []int32] -> Producer[[]int32].Sink()
public func Metadata() ISink[string?, [3]int32] -> Api.MetadataSink()
public func Ordinary(value [3]int32) ISink[string?, [3]int32] -> Producer[[3]int32].OrdinarySink()
public func Symbolic(value C) ISink[string?, [3]C] -> Producer[[3]C].Sink()`
        } else {
            `public func Match(value [3]int32) IView[string?, [3]int32] -> Producer[[3]int32].View(value)
public func Slice(value []int32) IView[string?, []int32] -> Producer[[]int32].View(value)
public func Metadata() IView[string?, [3]int32] -> Api.MetadataView()
public func Ordinary(value [3]int32) IView[string?, [3]int32] -> Producer[[3]int32].OrdinaryView(value)
public func Symbolic(value C) IView[string?, [3]C] -> Producer[[3]C].View([3]C{value, value, value})`
        }
        let source = "package ArrayViews5413\nimport ContextArrays5413\npublic class C {}\n" +
            "public class Exports { shared {\n" +
            body +
            "\npublic func Bare(value [3]int32) []int32 -> value\n} }\n"
        let apiReference = Path.Combine(fixture.Directory, "ArrayViews.ref.dll")
        let apiPdb = Path.Combine(fixture.Directory, "ArrayViews.pdb")
        let arguments = []string{
            "/assemblyname:ArrayViews",
            "/r:" + selected,
            "/refout:" + apiReference,
            "/pdb:" + apiPdb
        }
            .Concat(runtimeReferences.Select((path string) -> "/r:" + path)).ToArray()
        let api = fixture.Compile(source, "ArrayViews", executable: false, arguments)
        let first = []string{api, apiReference, apiPdb}.Select((path string) -> File.ReadAllBytes(path)).ToArray()
        fixture.Compile(source, "ArrayViews", executable: false, arguments)
        for var i = 0; i < first.Length; i++ {
            Assert.Equal(first[i], File.ReadAllBytes(([]string{api, apiReference, apiPdb})[i]))
        }
        let assertion = if contravariant {
            `foreach (var sink in new[] { matched, sliced, metadata, ordinary }) {
    sink.Put(values);
    if (!ReferenceEquals(Api.Last, values)) throw new Exception("Array storage changed.");
}
var objects = new[] { item, item, item };
symbolic.Put(objects);
if (!ReferenceEquals(Api.Last, objects) || Api.Puts != 5)
    throw new Exception("Symbolic storage or write count changed.");`
        } else {
            `if (!ReferenceEquals(matched.Second, values) || !ReferenceEquals(sliced.Second, values) ||
    !ReferenceEquals(ordinary.Second, values) || metadata.Second.Length != 3 || metadata.Second[1] != 20 ||
    symbolic.Second.Length != 3 || !ReferenceEquals(symbolic.Second[2], item) || Api.Puts != 0)
    throw new Exception("Array storage, metadata leniency, or symbolic identity changed.");`
        }
        let caller = fixture.CompileCSharp(
            "using System;\nusing ContextArrays5413;\nusing ArrayViews5413;\npublic static class Probe {\n" +
                "public static string Run() {\n" +
                `var values = new[] { 10, 20, 30 };
var item = new C();
var matched = Exports.Match(values);
var sliced = Exports.Slice(values);
var metadata = Exports.Metadata();
var ordinary = Exports.Ordinary(values);
var symbolic = Exports.Symbolic(item);
if (matched.First != null || sliced.First != null || metadata.First != null || symbolic.First != null ||
    ordinary.First != "ordinary" || Api.Calls != 5 || !ReferenceEquals(Exports.Bare(values), values))
    throw new Exception("Null payload, producer evaluation, ordinary variance, or bare widening changed.");
` +
                assertion +
                "\nreturn $\"True|{Api.Calls}|{Api.Puts}\";\n} }",
            "ArrayCaller",
            contract,
            apiReference
        )
        for image in[]string{contract, api, caller} {
            var report = string.Empty
            IlVerifier.Verify(
                image,
                runtimeReferences.Concat([]string{contract, api}),
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        let actual = cast[string](assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)!!)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                if contravariant {
                    "True|5|5"
                } else {
                    "True|5|0"
                }
            ),
            Encoding.UTF8.GetBytes(actual)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedPlatformVariance_PreservesUnchangedSymbolicValueArguments(useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReferences = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        let reference = Path.Combine(fixture.Directory, "TupleContract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`#nullable enable
namespace TupleContract5413;
public interface IView<out T, out U> { T First { get; } U Second { get; } }
public class ViewImpl<T, U>(T first, U second) : IView<T, U> {
    public T First => first;
    public U Second => second;
}
public static class Api { public static int Calls; }
public static class Maker<U> {
    public static IView<
#nullable disable
        string,
#nullable enable
        U> Create(U value) {
        Api.Calls++; return new ViewImpl<string, U>(null!, value);
    }
    public static IView<string, U> Ordinary(U value) {
        Api.Calls++; return new ViewImpl<string, U>("ordinary", value);
    }
}`, "TupleContract", reference)
        let selected = if useReference {
            reference
        } else {
            contract
        }
        const source = `package TupleViews5413
import TupleContract5413
public class C {}
public class Exports { shared {
public func Lift(value C) IView[string?, (C, int32)] {
    let pair = (value, 42)
    let view = Maker[(C, int32)].Create(pair)
    return view
}
public func Ordinary(value C) IView[string?, (C, int32)] -> Maker[(C, int32)].Ordinary((value, 42))
public func Present(value C) IView[string?, (C, int32)?] -> Maker[(C, int32)?].Create((value, 42))
public func Absent() IView[string?, (C, int32)?] -> Maker[(C, int32)?].Create(nil)
public func Closed() IView[string?, (string, int32)] -> Maker[(string, int32)].Create(("closed", 42))
} }`
        let apiReference = Path.Combine(fixture.Directory, "TupleViews.ref.dll")
        let apiPdb = Path.Combine(fixture.Directory, "TupleViews.pdb")
        let arguments = []string{
            "/assemblyname:TupleViews",
            "/r:" + selected,
            "/refout:" + apiReference,
            "/pdb:" + apiPdb
        }
            .Concat(runtimeReferences.Select((path string) -> "/r:" + path)).ToArray()
        let api = fixture.Compile(source, "TupleViews", executable: false, arguments)
        let first = []string{api, apiReference, apiPdb}.Select((path string) -> File.ReadAllBytes(path)).ToArray()
        fixture.Compile(source, "TupleViews", executable: false, arguments)
        for var i = 0; i < first.Length; i++ {
            Assert.Equal(first[i], File.ReadAllBytes(([]string{api, apiReference, apiPdb})[i]))
        }
        let caller = fixture.CompileCSharp(`using System;
using System.Reflection;
using TupleContract5413;
using TupleViews5413;
public static class Probe {
    public static string Run() {
        var item = new C();
        var lifted = Exports.Lift(item);
        var ordinary = Exports.Ordinary(item);
        var present = Exports.Present(item);
        var absent = Exports.Absent();
        var closed = Exports.Closed();
        if (lifted.First != null || ordinary.First != "ordinary" || present.First != null ||
            absent.First != null || closed.First != null || Api.Calls != 5 ||
            !ReferenceEquals(lifted.Second.Item1, item) || lifted.Second.Item2 != 42 ||
            !ReferenceEquals(ordinary.Second.Item1, item) || ordinary.Second.Item2 != 42 ||
            !present.Second.HasValue || !ReferenceEquals(present.Second.Value.Item1, item) ||
            present.Second.Value.Item2 != 42 || absent.Second.HasValue ||
            closed.Second.Item1 != "closed" || closed.Second.Item2 != 42)
            throw new Exception("Unchanged tuple storage, nulls, optionality, or evaluation changed.");
        var copy = lifted.Second;
        copy.Item1 = new C();
        if (!ReferenceEquals(lifted.Second.Item1, item))
            throw new Exception("A tuple read did not return a value copy.");
        var result = typeof(Exports).GetMethod("Lift")!.ReturnParameter;
        var info = new NullabilityInfoContext().Create(result);
        if (result.ParameterType.GenericTypeArguments[1] != typeof(ValueTuple<C, int>) ||
            typeof(Exports).GetMethod("Present")!.ReturnType.GenericTypeArguments[1] != typeof(ValueTuple<C, int>?) ||
            info.GenericTypeArguments[0].ReadState != NullabilityState.Nullable ||
            info.GenericTypeArguments[1].GenericTypeArguments[0].ReadState != NullabilityState.NotNull)
            throw new Exception("Tuple family or exported contracts changed.");
        return $"True|{Api.Calls}|{lifted.Second.Item2}";
    }
}`, "TupleCaller", contract, apiReference)
        for image in[]string{contract, api, caller} {
            var report = string.Empty
            IlVerifier.Verify(
                image,
                runtimeReferences.Concat([]string{contract, api}),
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal("True|5|42", assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
        for target in[]string{"(D, int32)", "(C, int64)", "(C, int32)?"} {
            let rejectedReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
            let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
            let (code, output) = fixture.TryCompile(
                "package TupleReject5413\nimport TupleContract5413\npublic class C {}\npublic class D {}\n" +
                    "public func Rejected(value C) IView[string?, $target] {\n" +
                    "let view = Maker[(C, int32)].Create((value, 42))\nreturn view\n}\n",
                "Rejected",
                executable: false,
                []string{"/r:" + selected, "/refout:" + rejectedReference, "/pdb:" + pdb}.Concat(
                    runtimeReferences.Select((path string) -> "/r:" + path)
                )
                    .ToArray()
            )
            Assert.NotEqual(0, code)
            Assert.Contains("Rejected.gs(7,8,7,12): error GS0155:", output, StringComparison.Ordinal)
            Assert.Equal(1, output.Split(": error GS", StringSplitOptions.None).Length - 1)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
            Assert.False(File.Exists(rejectedReference))
            Assert.False(File.Exists(pdb))
        }
    }

    private const ImportedNullableContract5408 string = `#nullable enable
using System.Collections.Generic;
namespace CopyAnnotated5408;
public record struct S<T>(T Value) {
    public readonly object Anchor = Api.Construct();
}
public record R<T>(T Value);
public static class Api {
    public static readonly object Marker = new();
    public static int Calls, Constructions;
    public static object Construct() { Constructions++; return Marker; }
    public static S<string?> Create() { Calls++; return new(null); }
    public static S<string> Required() { Calls++; return new("required"); }
    public static S<int> Value() { Calls++; return new(42); }
    public static S<int?> Optional() { Calls++; return new(null); }
    public static S<List<int>> NestedValue() { Calls++; return new(new() { 42 }); }
    public static S<List<int?>> NestedOptional() { Calls++; return new(new() { null }); }
    public static S<List<string?>> Nested() { Calls++; return new(new() { null }); }
    public static R<string?> Reference() { Calls++; return new(null); }
    public static R<string?>? Maybe() { Calls++; return null; }
    public static S<string?>? Lift() => Create();
}`

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedNullableGenericReturn_PreservesExplicitContracts(useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Contract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(ImportedNullableContract5408, "Contract", reference)
        const source = `package SameContract5408
import System.Collections.Generic
import CopyAnnotated5408
public class Exports {
    shared {
        public func Direct() S[string?] -> Api.Create()
        public func Local() S[string?] {
            let value S[string?] = Api.Create()
            return value
        }
        private func Receive(value S[string?]) S[string?] -> value
        public func Argument() S[string?] -> Receive(Api.Create())
        public func Required() S[string] -> Api.Required()
        public func Value() S[int32] -> Api.Value()
        public func Optional() S[int32?] -> Api.Optional()
        public func NestedValue() S[List[int32]] -> Api.NestedValue()
        public func NestedOptional() S[List[int32?]] -> Api.NestedOptional()
        public func Nested() S[List[string?]] -> Api.Nested()
        public func Reference() R[string?] -> Api.Reference()
        public func Lift() S[string?]? -> Api.Create()
        public func ReferenceLift() R[string?]? -> Api.Reference()
        public func Maybe() R[string?]? -> Api.Maybe()
    }
}`
        let apiReference = Path.Combine(fixture.Directory, "Api.ref.dll")
        let arguments = []string{
            "/assemblyname:Api",
            "/refout:" + apiReference,
            "/r:" + if useReference {
                reference
            } else {
                contract
            }
        }
        let api = fixture.Compile(source, "Api", executable: false, arguments)
        let firstImage = File.ReadAllBytes(api)
        let firstReference = File.ReadAllBytes(apiReference)
        let _ = fixture.Compile(source, "Api", executable: false, arguments)
        Assert.Equal(firstImage, File.ReadAllBytes(api))
        Assert.Equal(firstReference, File.ReadAllBytes(apiReference))
        let caller = fixture.CompileCSharp(`using System.Collections.Generic;
using CopyAnnotated5408;
using SameContract5408;
using System;
using System.Linq;
using System.Reflection;
public static class Probe {
    private static string Describe(NullabilityInfo info) => info.Type + ":" + info.ReadState + ":" + info.WriteState
        + "[" + string.Join(",", info.GenericTypeArguments.Select(Describe)) + "]";
    public static string Run() {
        foreach (var value in new[] { Exports.Direct(), Exports.Local(), Exports.Argument() }) {
            if (value.Value != null || !ReferenceEquals(value.Anchor, Api.Marker)
                || value.GetType() != typeof(S<string>)) throw new Exception("Nullable storage changed.");
        }
        var required = Exports.Required();
        var number = Exports.Value();
        var optional = Exports.Optional();
        var nestedValue = Exports.NestedValue();
        var nestedOptional = Exports.NestedOptional();
        var nested = Exports.Nested();
        var reference = Exports.Reference();
        var lifted = Exports.Lift();
        var referenceLift = Exports.ReferenceLift();
        if (required.Value != "required" || number.Value != 42 || optional.Value != null
            || optional.GetType() != typeof(S<int?>) || nested.Value.Count != 1
            || nestedValue.Value.Single() != 42 || nestedOptional.Value.Count != 1
            || nestedOptional.Value[0] != null || nestedOptional.GetType() != typeof(S<List<int?>>)
            || nested.Value[0] != null || reference.Value != null
            || reference.GetType() != typeof(R<string>)
            || !lifted.HasValue || lifted.Value.Value != null
            || !ReferenceEquals(lifted.Value.Anchor, Api.Marker)
            || referenceLift == null || referenceLift.Value != null || Exports.Maybe() != null)
            throw new Exception("Control contract changed.");
        if (Api.Calls != 13 || Api.Constructions != 10)
            throw new Exception("Conversion evaluated again or reconstructed a value.");
        var context = new NullabilityInfoContext();
        foreach (var name in new[] { "Direct", "Local", "Argument", "Reference" }) {
            var info = context.Create(typeof(Exports).GetMethod(name)!.ReturnParameter);
            if (info.GenericTypeArguments[0].ReadState != NullabilityState.Nullable)
                throw new Exception("Nullable argument metadata changed: " + name);
        }
        var nonnull = context.Create(typeof(Exports).GetMethod("Required")!.ReturnParameter);
        var nestedInfo = context.Create(typeof(Exports).GetMethod("Nested")!.ReturnParameter);
        var liftedInfo = context.Create(typeof(Exports).GetMethod("Lift")!.ReturnParameter);
        var nativeLiftInfo = context.Create(typeof(Api).GetMethod("Lift")!.ReturnParameter);
        var maybeInfo = context.Create(typeof(Exports).GetMethod("Maybe")!.ReturnParameter);
        if (nonnull.GenericTypeArguments[0].ReadState != NullabilityState.NotNull
            || nestedInfo.GenericTypeArguments[0].ReadState != NullabilityState.NotNull
            || nestedInfo.GenericTypeArguments[0].GenericTypeArguments[0].ReadState != NullabilityState.Nullable
            || Describe(liftedInfo) != Describe(nativeLiftInfo)
            || maybeInfo.ReadState != NullabilityState.Nullable
            || maybeInfo.GenericTypeArguments[0].ReadState != NullabilityState.Nullable)
            throw new Exception("Nested or non-null metadata changed.");
        return "nullable-contract|storage|once|metadata";
    }
}`, "Caller", contract, apiReference)
        IlVerifier.Verify(contract)
        IlVerifier.Verify(api, []string{contract})
        IlVerifier.Verify(caller, []string{contract, api})
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal(
            "nullable-contract|storage|once|metadata",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
    }

    @Theory
    @InlineData("S[string]", "Api.Create()", false)
    @InlineData("S[string]", "Api.Create()", true)
    @InlineData("S[string?]", "Api.Required()", false)
    @InlineData("S[string?]", "Api.Required()", true)
    @InlineData("S[object?]", "Api.Create()", false)
    @InlineData("S[object?]", "Api.Create()", true)
    @InlineData("S[List[string]]", "Api.Nested()", false)
    @InlineData("S[List[string]]", "Api.Nested()", true)
    @InlineData("R[string]", "Api.Reference()", false)
    @InlineData("R[string]", "Api.Reference()", true)
    @InlineData("R[string?]", "Api.Maybe()", false)
    @InlineData("R[string?]", "Api.Maybe()", true)
    @InlineData("S[int32]", "Api.Optional()", false)
    @InlineData("S[int32]", "Api.Optional()", true)
    @InlineData("S[int32?]", "Api.Value()", false)
    @InlineData("S[int32?]", "Api.Value()", true)
    @InlineData("S[List[int32]]", "Api.NestedOptional()", false)
    @InlineData("S[List[int32]]", "Api.NestedOptional()", true)
    @InlineData("S[List[int32?]]", "Api.NestedValue()", false)
    @InlineData("S[List[int32?]]", "Api.NestedValue()", true)
    func ImportedNullableGenericReturn_RejectsDifferentInvariantContracts(
        target string,
        expression string,
        useReference bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Contract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(ImportedNullableContract5408, "Contract", reference)
        let outputReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let (code, output) = fixture.TryCompile(
            "import System.Collections.Generic\nimport CopyAnnotated5408\npublic func Rejected() " +
                target +
                " -> " +
                expression +
                "\n",
            "Rejected",
            executable: false,
            "/r:" + if useReference {
                reference
            } else {
                contract
            },
            "/refout:" + outputReference
        )
        let start = 28 + target.Length
        let end = start + expression.Length
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("Rejected.gs(3,$start,3,$end): error GS0155", StringComparison.Ordinal), output)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(outputReference))
    }

    @Theory
    @InlineData("source")
    @InlineData("implementation")
    @InlineData("reference")
    func NullableGenericCopy_PreservesArgumentsAcrossSourceAndImportedRepresentations(representation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const declaration = `public data struct S[T](Value T)
public class Factory {
    shared {
        public func NonNull() S[string] -> S[string]{Value: "nonnull"}
        public func Optional() S[int32?] -> S[int32?]{Value: nil}
        public func Nullable() S[string?] -> S[string?]{Value: nil}
    }
}`
        var prefix = declaration
        var references = []string{}
        if representation != "source" {
            let reference = Path.Combine(fixture.Directory, "Producer.ref.dll")
            let producer = fixture.Compile(
                "package NullableCopy5405\n" + declaration,
                "Producer",
                executable: false,
                "/assemblyname:Producer",
                "/refout:" + reference
            )
            IlVerifier.Verify(producer)
            references = []string{
                "/r:" + if representation == "reference" {
                    reference
                } else {
                    producer
                }
            }
            prefix = "import NullableCopy5405"
        }
        let image = fixture.Compile("import System\nimport System.Collections.Generic\n" + prefix + `
let original = S[string?]{Value: nil}
let copy = original with{}
Console.WriteLine(copy.Value == nil)
let changed = original with { Value = "payload" }
Console.WriteLine(changed.Value == "payload")
let cleared = changed.copy(Value: nil)
Console.WriteLine(cleared.Value == nil)
Console.WriteLine(original.Value == nil)
`, "Consumer", executable: true, references)
        let dependencies = if representation == "source" {
            []string{}
        } else {
            []string{Path.Combine(fixture.Directory, "Producer.dll")}
        }
        IlVerifier.Verify(image, dependencies)
        Assert.Equal(
            Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("True" + Environment.NewLine, 4))),
            fixture.RunBytes(image)
        )
        let controls = []string{`let original = Factory.NonNull()
Console.WriteLine(original.copy().Value == "nonnull")`, `let original = S[List[string?]]{Value: List[string?]()}
original.Value.Add(nil)
let copy = original with{}
Console.WriteLine(copy.Value[0] == nil)`, `let original = Factory.Optional()
Console.WriteLine(original.copy().Value == nil)`, `let original = S[(Text string?, Number int32)]{Value: (Text: nil, Number: 7)}
let copy = original with{}
Console.WriteLine(copy.Value.Text == nil && copy.Value.Number == 7)`, `let original = Factory.Nullable()
let copy = original with { Value = nil }
Console.WriteLine(copy.copy().Value == nil)`}
        for var index = 0; index < controls.Length; index++ {
            let control = fixture.Compile(
                "import System\nimport System.Collections.Generic\n" + prefix + "\n" + controls[index],
                "Control" + index.ToString(),
                executable: true,
                references
            )
            IlVerifier.Verify(control, dependencies)
            Assert.Equal(Encoding.UTF8.GetBytes("True" + Environment.NewLine), fixture.RunBytes(control))
        }
    }

    @Theory
    @InlineData("with{}")
    @InlineData(".copy()")
    func NullableGenericCopy_RejectsNarrowingWithoutAnImage(operation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let producerReference = Path.Combine(fixture.Directory, "Producer.ref.dll")
        let producer = fixture.Compile(
            "package NullableCopy5405\npublic data struct S[T](Value T)\npublic data class C[T](Value T)",
            "Producer",
            executable: false,
            "/assemblyname:Producer",
            "/refout:" + producerReference
        )
        let reference = Path.Combine(fixture.Directory, "Narrowing.ref.dll")
        let (code, output) = fixture.TryCompile(
            "import NullableCopy5405\nlet original = S[string?]{Value: nil}\nlet copy = original " +
                operation +
                "\nlet required string = copy.Value",
            "Narrowing",
            executable: true,
            "/r:" + producer,
            "/refout:" + reference
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("Narrowing.gs(4,23,4,33): error GS0155", StringComparison.Ordinal), output)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Narrowing.dll")))
        Assert.False(File.Exists(reference))
        for typeName in[]string{"C", "S"} {
            for selected in[]string{producer, producerReference} {
                let rejectedReference = Path.Combine(fixture.Directory, "NullableReceiver.ref.dll")
                let (nullableCode, nullableOutput) = fixture.TryCompile(
                    "import NullableCopy5405\nfunc Copy(value " +
                        typeName +
                        "[string?]?) " +
                        typeName +
                        "[string?]? -> value " +
                        operation +
                        "\nlet unused = Copy(nil)",
                    "NullableReceiver",
                    executable: true,
                    "/r:" + selected,
                    "/refout:" + rejectedReference
                )
                Assert.NotEqual(0, nullableCode)
                let expectedDiagnostic = if operation == "with{}" {
                    "NullableReceiver.gs(2,51,2,55): error GS0161:"
                } else {
                    "NullableReceiver.gs(2,52,2,58): error GS0159:"
                }
                Assert.Contains(expectedDiagnostic, nullableOutput)
                Assert.Equal(1, nullableOutput.Split(": error GS", StringSplitOptions.None).Length - 1)
                Assert.DoesNotContain("GS9998", nullableOutput, StringComparison.Ordinal)
                Assert.False(File.Exists(Path.Combine(fixture.Directory, "NullableReceiver.dll")))
                Assert.False(File.Exists(rejectedReference))
                let control = fixture.Compile(
                    "import System\nimport NullableCopy5405\nfunc Narrow(value " +
                        typeName +
                        "[string?]?) bool {\nif value != nil { let changed = value " +
                        operation +
                        "\nreturn changed.Value == nil }\nreturn true\n}\nlet original = " +
                        typeName +
                        "[string?](nil)\nlet copy = original " +
                        operation +
                        "\nConsole.WriteLine(copy.Value == nil && Narrow(original) && Narrow(nil))",
                    "NonNullableReceiver",
                    executable: true,
                    "/r:" + selected
                )
                IlVerifier.Verify(control, []string{producer})
                Assert.Equal(Encoding.UTF8.GetBytes("True" + Environment.NewLine), fixture.RunBytes(control))
            }
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedNullableGenericCopy_PreservesStorageAndRunsOnlyExplicitUpdates(useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Contract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`namespace CopyContract5405;
public static class Trace {
    public static int Constructions, Receivers, Updates;
    public static object Anchor() { Constructions++; return new object(); }
    public static string? Next() { Updates++; return null; }
}
public record struct Box<T>(T Value) {
    public int Extra;
    public object Anchor = Trace.Anchor();
    private readonly object hidden = new object();
    public object Hidden() => hidden;
}
public static class Oracle {
    public static Box<string?> Copy(Box<string?> original) =>
        original with { Value = Trace.Next() };
    public static Box<string?> Original() => new(null);
}`, "Contract", reference)
        let api = fixture.Compile(`package CopyApi5405
import CopyContract5405
public class Api {
    shared {
        public func Receive(original Box[string?]) Box[string?] {
            Trace.Receivers++
            return original
        }
        public func Copy(original Box[string?]) Box[string?] ->
            Receive(original) with { Value = Trace.Next() }
        public func Sugar(original Box[string?]) Box[string?] ->
            Receive(original).copy(Value: Trace.Next())
        public func Empty(original Box[string?]) Box[string?] -> original with{}
        public func Field[T any](original Box[T]) Box[T] -> original with { Extra = 1 }
        public func FieldSugar[T any](original Box[T]) Box[T] -> original.copy(Extra: 1)
        public func FromContract() bool {
            let copy = Oracle.Original() with { Value = nil }
            return copy.Value == nil
        }
    }
}
`, "Api", executable: false, "/assemblyname:Api", "/r:" +
                if useReference {
                reference
            } else {
                contract
            })
        let caller = fixture.CompileCSharp(`using CopyContract5405;
using System;
public static class Probe {
    public static string Run() {
        var original = new Box<string?>("payload");
        var anchor = original.Anchor;
        var hidden = original.Hidden();
        foreach (var copy in new Func<Box<string?>, Box<string?>>[] {
            CopyApi5405.Api.Copy, CopyApi5405.Api.Sugar
        }) {
            Trace.Receivers = Trace.Updates = 0;
            var changed = copy(original);
            if (changed.Value != null || original.Value != "payload"
                || !ReferenceEquals(changed.Anchor, anchor) || !ReferenceEquals(changed.Hidden(), hidden)
                || Trace.Constructions != 1 || Trace.Receivers != 1 || Trace.Updates != 1)
                throw new Exception("Copy changed storage or replayed construction.");
            changed.Anchor = new object();
            if (!ReferenceEquals(original.Anchor, anchor)) throw new Exception("Copy aliases original storage.");
        }
        var empty = CopyApi5405.Api.Empty(original);
        if (empty.Value != "payload" || !ReferenceEquals(empty.Hidden(), hidden)
            || Trace.Constructions != 1) throw new Exception("Empty copy reconstructed storage.");
        foreach (var changed in new[] { CopyApi5405.Api.Field(original), CopyApi5405.Api.FieldSugar(original) })
            if (changed.Extra != 1 || original.Extra != 0 || changed.Value != "payload"
                || !ReferenceEquals(changed.Hidden(), hidden) || Trace.Constructions != 1)
                throw new Exception("Open reference-type field copy changed storage.");
        foreach (var changed in new[] {
            CopyApi5405.Api.Field(default(Box<int>)), CopyApi5405.Api.FieldSugar(default(Box<int>))
        })
            if (changed.Extra != 1 || changed.Value != 0 || Trace.Constructions != 1)
                throw new Exception("Open value-type field copy changed storage.");
        var native = Oracle.Copy(original);
        if (native.Value != null || !ReferenceEquals(native.Anchor, anchor)
            || !ReferenceEquals(native.Hidden(), hidden) || Trace.Constructions != 1)
            throw new Exception("Native copy oracle disagrees.");
        if (!CopyApi5405.Api.FromContract() || Trace.Constructions != 2)
            throw new Exception("Annotated return lost nullability or reconstructed storage.");
        var fresh = new Box<string?>(null);
        if (Trace.Constructions != 3 || ReferenceEquals(fresh.Anchor, anchor))
            throw new Exception("Fresh construction control did not execute.");
        return "copy-only|nullable|identity|once";
    }
}`, "Caller", contract, api)
        IlVerifier.Verify(contract)
        IlVerifier.Verify(api, []string{contract})
        IlVerifier.Verify(caller, []string{contract, api})
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal(
            "copy-only|nullable|identity|once",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
    }

    @Theory
    @InlineData("Value", false)
    @InlineData("Value", true)
    @InlineData("Fixed", false)
    @InlineData("Fixed", true)
    func ImportedNullableGenericCopy_PrefersNearestFieldOverInheritedProperty(member string, useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Contract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`namespace CopyMembers5405;
public record Base {
    public int Value { get; set; } = 41;
    public int Fixed { get; } = 42;
    public int Other = 43;
}
public record Derived<T>(T Payload) : Base {
    public new int Value;
    public new int Fixed;
    public new int Other { get; set; }
}`, "Contract", reference)
        let api = fixture.Compile((`package CopyMembersApi5405
import CopyMembers5405
public class Api {
    shared {
        public func With(value Derived[string?]) Derived[string?] -> value with { MEMBER = 9 }
        public func Sugar(value Derived[string?]) Derived[string?] -> value.copy(MEMBER: 9)
        public func Property(value Derived[string?]) Derived[string?] -> value with { Other = 11 }
        public func PropertySugar(value Derived[string?]) Derived[string?] -> value.copy(Other: 11)
    }
}
`).Replace(
                "MEMBER",
                member
            ), "Api", executable: false, "/assemblyname:Api", "/r:" +
                if useReference {
                reference
            } else {
                contract
            })
        let caller = fixture.CompileCSharp((`using CopyMembers5405;
using CopyMembersApi5405;
using System;
public static class Probe {
    public static bool Run() {
        var original = new Derived<string?>(null);
        var expected = original with { MEMBER = 9 };
        foreach (var changed in new[] { Api.With(original), Api.Sugar(original) }) {
            if (changed.MEMBER != expected.MEMBER || original.MEMBER != 0
                || ((Base)changed).MEMBER != ((Base)original).MEMBER
                || ReferenceEquals(changed, original) || changed.Payload != null)
                throw new Exception("Copy did not select the nearest field.");
        }
        foreach (var changed in new[] { Api.Property(original), Api.PropertySugar(original) }) {
            if (changed.Other != 11 || original.Other != 0 || ((Base)changed).Other != 43)
                throw new Exception("A farther field replaced the nearest property.");
        }
        return true;
    }
}
`).Replace("MEMBER", member), "Caller", contract, api)
        IlVerifier.Verify(contract)
        IlVerifier.Verify(api, []string{contract})
        IlVerifier.Verify(caller, []string{contract, api})
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal(true, assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Theory
    @InlineData("int", "42")
    @InlineData("string", "\"payload\"")
    func ValueCopy_InitializesOnlyFreshValuesAndPreservesStateAndOrder(csType string, payload string) {
        using let native = CSharpFixture(`namespace NativeCopy4776;
public static class Trace {
    public static int Initializations;
    public static string Events = "";
    public static object Identity() { Initializations++; return new object(); }
    public static int Update(int value) { Events += value + ";"; return value; }
}
public record struct Value<T>(int First, int Second) {
    public object Anchor = Trace.Identity();
    private readonly object saved = new object();
    public T Payload;
    public object Hidden() => saved;
    public Value<T> Copy(int value) => this with { Second = Trace.Update(21), First = Trace.Update(value) };
}`)
        let image = Compile(native.DirectoryPath, `package ValueCopy4776
import NativeCopy4776
public data struct Value[T any](First int32, Second int32) {
    public var Anchor object = Trace.Identity()
    private let Saved object = System.Object()
    public var Payload T
    public func Hidden() object -> Saved
    public func Receive() Value[T] {
        Trace.Events = Trace.Events + "R;"
        return this
    }
    public func Copy(value int32) Value[T] ->
        this.Receive() with { Second = Trace.Update(21), First = Trace.Update(value) }
    public func Sugar(value int32) Value[T] ->
        this.Receive().copy(Second: Trace.Update(21), First: Trace.Update(value))
    public func Empty() Value[T] -> this with { }
}`, native.AssemblyPath)
        IlVerifier.Verify(native.AssemblyPath)
        IlVerifier.Verify(image, []string{native.AssemblyPath})
        using let caller = CSharpFixture((`using NativeCopy4776;
public static class Probe {
    private static void Check(bool value, string reason) {
        if (!value) throw new System.Exception(reason);
    }
    public static string Run() {
        Trace.Initializations = 0;
        var original = new ValueCopy4776.Value<` + "$csType" + `>(7, 8) { Payload = ` + "$payload" + ` };
        var anchor = original.Anchor;
        var operations = new System.Func<ValueCopy4776.Value<` + "$csType" + `>> [] {
            () => original.Copy(13), () => original.Sugar(13)
        };
        foreach (var operation in operations) {
            Trace.Events = "";
            var copy = operation();
            Check(Trace.Initializations == 1, "copy reran declaration initializer");
            Check(Trace.Events == "R;21;13;", "copy update order");
            Check(copy.First == 13 && copy.Second == 21 && original.First == 7 && original.Second == 8, "copy field values");
            Check(object.ReferenceEquals(anchor, copy.Anchor) && object.ReferenceEquals(anchor, original.Anchor), "copy identity");
            Check(object.ReferenceEquals(original.Hidden(), copy.Hidden()), "private readonly copy identity");
            Check(object.Equals(copy.Payload, original.Payload), "copy payload");
        }
        var empty = original.Empty();
        Check(Trace.Initializations == 1 && object.ReferenceEquals(empty.Anchor, anchor), "empty copy construction");
        Trace.Initializations = 0;
        var native = new NativeCopy4776.Value<` + "$csType" + `>(7, 8) { Payload = ` + "$payload" + ` };
        Trace.Events = "";
        var nativeCopy = native.Copy(13);
        Check(Trace.Initializations == 1 && Trace.Events == "21;13;", "native copy oracle");
        Check(nativeCopy.First == 13 && nativeCopy.Second == 21 && native.First == 7 && native.Second == 8, "native field oracle");
        Check(object.ReferenceEquals(native.Anchor, nativeCopy.Anchor) && object.Equals(native.Payload, nativeCopy.Payload), "native state oracle");
        Check(object.ReferenceEquals(native.Hidden(), nativeCopy.Hidden()), "native private readonly oracle");
        return "fresh-once|receiver-once|ordered|state";
    }
}`), []PortableExecutableReference{
                MetadataReference.CreateFromFile(Path.ChangeExtension(image, ".ref.dll")),
                MetadataReference.CreateFromFile(native.AssemblyPath)
            })
        IlVerifier.Verify(caller.AssemblyPath, []string{image, native.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(image),
            File.ReadAllBytes(caller.AssemblyPath)
        )
        Assert.Equal(
            "fresh-once|receiver-once|ordered|state",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
    }

    @Theory
    @InlineData("int", "42", false)
    @InlineData("string", "\"payload\"", false)
    @InlineData("int", "42", true)
    func ClassCopyTree_CallsVirtualTypedCloneAndPreservesLiveState(csType string, payload string, throughBase bool) {
        using let native = CSharpFixture(`using System;
using System.Linq.Expressions;
namespace NativeCopy4776;
public static class Trace {
    public static int Initializations;
    public static string Events = "";
    public static object Identity() { Initializations++; return new object(); }
    public static int Update(int value) { Events += value + ";"; return value; }
}
public record Root<T>(int First) {
    private readonly object anchor = Trace.Identity();
    public T Payload;
    public int State;
    public object Anchor() => anchor;
    public Root<T> Receive() { Trace.Events += "R;"; return this; }
}
public record Leaf<T>(int Second) : Root<T>(7);
public static class Oracle {
    public static Expression<Func<Root<T>>> Build<T>(Root<T> original) {
        var received = Expression.Variable(typeof(Root<T>), "received");
        var copied = Expression.Variable(typeof(Root<T>), "copied");
        var clone = typeof(Root<T>).GetMethod("<Clone>$", Type.EmptyTypes);
        var update = typeof(Trace).GetMethod(nameof(Trace.Update));
        return Expression.Lambda<Func<Root<T>>>(Expression.Block(new[] { received, copied },
            Expression.Assign(received, Expression.Call(Expression.Constant(original), typeof(Root<T>).GetMethod("Receive"))),
            Expression.Assign(copied, Expression.Call(received, clone)),
            Expression.Assign(Expression.Field(copied, "State"), Expression.Call(update, Expression.Constant(21))),
            Expression.Assign(Expression.Property(copied, "First"), Expression.Call(update, Expression.Constant(13))),
            copied));
    }
}`)
        let image = Compile(native.DirectoryPath, `package ClassCopyTree4776
import System
import System.Linq.Expressions
import NativeCopy4776
public open data class Root[T any](First int32) {
    private let Saved object = Trace.Identity()
    public var Payload T
    public var State int32
    public func Anchor() object -> Saved
    public func Receive() Root[T] {
        Trace.Events = Trace.Events + "R;"
        return this
    }
}
public data class Leaf[T any](Second int32) : Root[T](7) {
    public func ReceiveLeaf() Leaf[T] {
        Trace.Events = Trace.Events + "R;"
        return this
    }
}
public class Api {
    shared {
        public func Build[T any](original Leaf[T]) Expression[Func[Leaf[T]]] ->
            () -> original.ReceiveLeaf() with { State = Trace.Update(21), First = Trace.Update(13) }
        public func Sugar[T any](original Leaf[T]) Expression[Func[Leaf[T]]] ->
            () -> original.ReceiveLeaf().copy(State: Trace.Update(21), First: Trace.Update(13))
        public func Base[T any](original Root[T]) Expression[Func[Root[T]]] ->
            () -> original.Receive() with { State = Trace.Update(21), First = Trace.Update(13) }
        public func Scalar() Expression[Func[int32]] -> () -> 7
    }
}`, native.AssemblyPath)
        IlVerifier.Verify(native.AssemblyPath)
        IlVerifier.Verify(image, []string{native.AssemblyPath})
        using let caller = CSharpFixture((`using NativeCopy4776;
using ClassCopyTree4776;
using System.Linq.Expressions;
public static class Probe {
    private static void Check(bool value, string reason) {
        if (!value) throw new System.Exception(reason);
    }
    public static string Run() {
        Trace.Initializations = 0;
        var original = new ClassCopyTree4776.Leaf<` + "$csType" + `>(8) { State = 31 };
        var anchor = original.Anchor();
        var tree = ` + "${(if throughBase { "Api.Base(original)" } else { "Api.Build(original)" })}" + `;
        Check(Trace.Initializations == 1 && Trace.Events == "", "tree construction executed copy");
        original.State = 41;
        original.Payload = ` + "$payload" + `;
        var run = tree.Compile();
        for (var index = 0; index < 2; index++) {
            Trace.Events = "";
            var copy = run();
            Check(copy.GetType() == original.GetType() && !object.ReferenceEquals(copy, original), "virtual clone runtime identity");
            Check(copy.First == 13 && copy.State == 21 && ((ClassCopyTree4776.Leaf<` + "$csType" + `>)copy).Second == 8, "clone values");
            Check(original.First == 7 && original.State == 41 && original.Second == 8, "original state");
            Check(object.ReferenceEquals(copy.Anchor(), anchor) && object.Equals(copy.Payload, original.Payload), "private base copy state");
            Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;", "tree clone once and order");
        }
        var sugar = Api.Sugar(original).Compile();
        Trace.Events = "";
        var sugarCopy = sugar();
        Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;" && object.ReferenceEquals(sugarCopy.Anchor(), anchor), "copy sugar tree");
        Trace.Initializations = 0;
        Trace.Events = "";
        var native = new NativeCopy4776.Leaf<` + "$csType" + `>(8) { Payload = ` + "$payload" + `, State = 41 };
        var nativeTree = Oracle.Build<` + "$csType" + `>(native);
        Check(Trace.Initializations == 1 && Trace.Events == "", "native tree creation");
        Trace.Events = "";
        var nativeCopy = nativeTree.Compile()();
        Check(nativeCopy.GetType() == native.GetType() && !object.ReferenceEquals(nativeCopy, native), "native virtual clone");
        Check(nativeCopy.First == 13 && nativeCopy.State == 21 && ((NativeCopy4776.Leaf<` + "$csType" + `>)nativeCopy).Second == 8, "native tree values");
        Check(object.ReferenceEquals(nativeCopy.Anchor(), native.Anchor()) && object.Equals(nativeCopy.Payload, native.Payload), "native private state");
        Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;" && native.State == 41, "native once and order");
        Check(Api.Scalar().Compile()() == 7, "supported tree control");
        return "virtual|private-base|typed|live|once|ordered";
    }
}`), []PortableExecutableReference{
                MetadataReference.CreateFromFile(Path.ChangeExtension(image, ".ref.dll")),
                MetadataReference.CreateFromFile(native.AssemblyPath)
            })
        IlVerifier.Verify(caller.AssemblyPath, []string{image, native.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(image),
            File.ReadAllBytes(caller.AssemblyPath)
        )
        Assert.Equal(
            "virtual|private-base|typed|live|once|ordered",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
        let api Type? = assemblies[1].GetType("ClassCopyTree4776.Api")
        let owner = assemblies[1].GetType("ClassCopyTree4776.Leaf`1")!!.MakeGenericType(
            if csType == "int" {
                typeof(int32)
            } else {
                typeof(string)
            }
        )
        let originalObject object? = Activator.CreateInstance(owner, 8)
        let method = api!!.GetMethod(
            if throughBase {
                "Base"
            } else {
                "Build"
            }
        )!!.MakeGenericMethod(
            if csType == "int" {
                typeof(int32)
            } else {
                typeof(string)
            }
        )
        let tree = Assert.IsAssignableFrom[ExpressionsLambdaExpression](method.Invoke(nil, []object{originalObject}))
        let visitor = CopyVisitor()
        visitor.Visit(tree.Body)
        let clone = Assert.Single(visitor.Clones)
        Assert.True(clone.Method.IsVirtual)
        Assert.Equal(tree.ReturnType, clone.Method.DeclaringType)
        Assert.Equal(tree.ReturnType, clone.Method.ReturnType)
        Assert.Empty(clone.Arguments)
        Assert.Empty(visitor.Constructions)
    }

    @Fact
    func ImportedClassCopyTree_KeepsExistingPreciseUnsupportedBoundary() {
        using let native = CSharpFixture("namespace NativeCopy4776; public record Root<T>(T Value);")
        const expression = "original with { }"
        let source = (`package ImportedCopyTree4776
import System
import System.Linq.Expressions
import NativeCopy4776
public func Build(original Root[int32]) Expression[Func[Root[int32]]] -> () -> ` + "$expression")
        using let references = native.RuntimeReferences()
        let compilation = GsCompilation(references, GsSyntaxTree.Parse(GsSourceText.From(source))){IsLibrary = true}
        using let image = MemoryStream()
        let result = compilation.Emit(image, pdbStream: nil, refStream: nil, assemblyName: "UnsupportedCopyTree")
        Assert.False(result.Success)
        let diagnostic = Assert.Single(
            result.Diagnostics.Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0473")
        )
        Assert.Equal(expression, source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length))
    }

    private class CopyVisitor : ExpressionVisitor {
        init() {
            Clones = List[MethodCallExpression]()
            Constructions = List[NewExpression]()
        }

        prop Clones List[MethodCallExpression] {
            get;
        }

        prop Constructions List[NewExpression] {
            get;
        }

        protected override func VisitMethodCall(node MethodCallExpression) Expression {
            if node.Method.Name == "<Clone>$$" {
                Clones.Add(node)
            }
            return base.VisitMethodCall(node)
        }

        protected override func VisitNew(node NewExpression) Expression {
            Constructions.Add(node)
            return base.VisitNew(node)
        }
    }

    shared {
        private func Compile(directory string, source string, reference string) string {
            let sourcePath = Path.Combine(directory, "Fixture.gs")
            let image = Path.Combine(directory, "Fixture.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                let exit = Program.Main(
                    []string{
                        "/target:library",
                        "/targetframework:net10.0",
                        "/assemblyname:Fixture",
                        "/out:" + image,
                        "/refout:" + Path.ChangeExtension(image, ".ref.dll"),
                        "/reference:" + reference,
                        sourcePath
                    }
                )
                Assert.True(exit == 0, (`gsc exited ` + "$exit" + `
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(File.Exists(image))
            Assert.True(File.Exists(Path.ChangeExtension(image, ".ref.dll")))
            return image
        }
    }
}
