// <copyright file="Issue4777ImportedRecordEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import System.Text
import System.Text.Json
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import Microsoft.CodeAnalysis.Text
import Xunit
import Xunit.Abstractions
import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic

/// Imported direct record equality uses the same base contract as source inheritance.
class Issue4777ImportedRecordEqualityTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData(false, "ordinary")
    @InlineData(true, "ordinary")
    @InlineData(false, "constrained")
    @InlineData(true, "constrained")
    @InlineData(false, "methodgroup")
    @InlineData(true, "methodgroup")
    func ConstructedSourceBase_OrdinaryCallsAndGroupsUseDeclaringEquality(genericReceiver bool, path string) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        using let fixture = NativeSliceLanguageTests.Fixture()
        try {
            let receiver = if genericReceiver {
                "Middle[string]"
            } else {
                "Closed"
            }
            let nativeReceiver = if genericReceiver {
                "Middle<string>"
            } else {
                "Closed"
            }
            let constrained = path == "constrained"
            let comparison = if path == "methodgroup" {
                "let equals Func[Root[string]?, bool] = left.Equals\nreturn NativeOracle.Observe(equals(right), expected)"
            } else {
                "return NativeOracle.Observe(left.Equals(right), expected)"
            }
            let root = CompileNative(fixture.Directory, "NativeOracle", `using System;
namespace ConstructedEquality;
public static class NativeOracle {
    public static int Calls;
    public static bool Observe(bool actual, bool expected) {
        Calls++;
        if (actual != expected) throw new Exception("constructed inherited equality");
        return actual;
    }
}`)
            let source = (`package ConstructedEquality
import System
public open data class Root[T any](Tag int32) : IEquatable[Root[T]]
public open class Middle[T any](State int32) : Root[T](0) {
    public func ReadState() int32 -> State
}
public open class Closed(State int32) : Middle[string](State)
public class Checks {
    shared {
        public func Compare` + "${(if constrained { "[U " + receiver + "]" } else { "" })}" + `(
            left ` + "${(if constrained { "U" } else { receiver })}" + `, right Root[string]?, expected bool) bool {
            ` + "$comparison" + `
        }
    }
}`)
            let reference = Path.Combine(fixture.Directory, "Contracts.ref.dll")
            File.WriteAllText(
                Path.Combine(fixture.Directory, "gsc-invocation.json"),
                JsonSerializer.Serialize(
                    AnonymousType6_52711CDFEDA9EBD9(
                        "GSharp.Compiler.Program.Main",
                        typeof(Program).Assembly.Location,
                        Hash(typeof(Program).Assembly.Location),
                        typeof(TypeSymbol).Assembly.Location,
                        Hash(typeof(TypeSymbol).Assembly.Location),
                        []string{
                            "/out:" + Path.Combine(fixture.Directory, "Contracts.dll"),
                            "/target:library",
                            "/targetframework:net10.0",
                            Path.Combine(fixture.Directory, "Contracts.gs"),
                            "/assemblyname:Contracts",
                            "/r:" + root,
                            "/refout:" + reference,
                            "/debug:portable"
                        }
                    )
                )
            )
            let library = fixture.Compile(
                source,
                "Contracts",
                executable: false,
                "/assemblyname:Contracts",
                "/r:" + root,
                "/refout:" + reference,
                "/debug:portable"
            )
            let nativeDirectory = Path.Combine(fixture.Directory, "native")
            Directory.CreateDirectory(nativeDirectory)
            // C# records cannot have an ordinary class descendant; this native CLR oracle
            // spells the same root equality contract explicitly for that legal G# shape.
            let native = CompileNative(nativeDirectory, "Contracts", (`using System;
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
namespace ConstructedEquality;
public class Root<T> : IEquatable<Root<T>> {
    public int Tag { get; init; }
    public Root(int tag) => Tag = tag;
    public virtual bool Equals(Root<T>? other) =>
        other != null && GetType() == other.GetType() && Tag == other.Tag;
    public override bool Equals(object? other) => other is Root<T> root && Equals(root);
    public override int GetHashCode() => Tag;
}
public class Middle<T> : Root<T> {
    public int State { get; init; }
    public Middle(int state) : base(0) => State = state;
    public int ReadState() => State;
}
public class Closed : Middle<string> {
    public Closed(int state) : base(state) { }
}
public class Checks {
    public static bool Compare` + "${(if constrained { "<U>" } else { "" })}" + `(
        ` + "${(if constrained { "U" } else { nativeReceiver })}" + ` left, Root<string>? right, bool expected)
        ` + "${(if constrained { "where U : " + nativeReceiver } else { "" })}" + ` {
        ` + "${(if path == "methodgroup" { "Func<Root<string>?, bool> equals = left.Equals;\nreturn NativeOracle.Observe(equals(right), expected);" } else { "return NativeOracle.Observe(left.Equals(right), expected);" })}" + `
    }
}`), root)
            let consumer = CompileNative(fixture.Directory, "Consumer", (`using System;
using ConstructedEquality;
public static class Consumer {
    public static string Run(string ignored) {
        var first = new ` + "$nativeReceiver" + `(7) { Tag = 41 };
        var same = new ` + "$nativeReceiver" + `(7) { Tag = 41 };
        var inherited = new ` + "$nativeReceiver" + `(7) { Tag = 42 };
        var ordinary = new ` + "$nativeReceiver" + `(8) { Tag = 41 };
        NativeOracle.Calls = 0;
        if (!Checks.Compare(first, same, true)
            || Checks.Compare(first, inherited, false)
            || !Checks.Compare(first, ordinary, true)
            || Checks.Compare(first, null, false))
            throw new Exception("constructed caller control");
        if (NativeOracle.Calls != 4 || first.Tag != 41 || first.ReadState() != 7)
            throw new Exception("constructed call-count/state control");
        return "constructed/equal/inherited-difference/ordinary-state/null";
    }
}`), root, reference)
            for image in[]string{root, native, library, reference} {
                IlVerifier.Verify(image, []string{root})
            }
            IlVerifier.Verify(consumer, []string{root, native})
            IlVerifier.Verify(consumer, []string{root, library})
            let expected = "constructed/equal/inherited-difference/ordinary-state/null"
            let nativeResult object? = RunConsumer(root, native, consumer, path)
            let gsharpResult object? = RunConsumer(root, library, consumer, path)
            Assert.Equal(expected, nativeResult)
            Assert.Equal(expected, gsharpResult)
            File.WriteAllText(
                Path.Combine(fixture.Directory, "same-consumer-runtime.json"),
                JsonSerializer.Serialize(
                    AnonymousType6_72319ECD357A6A9B(
                        path,
                        genericReceiver,
                        Hash(consumer),
                        nativeResult,
                        gsharpResult,
                        expected
                    )
                )
            )
            this.output.WriteLine("SAME constructed native consumer SHA256=" + Hash(consumer))
            Assert.Equal(EqualityRows(library, expectedCount: 2), EqualityRows(reference, expectedCount: 2))
            let assemblies = EmittedFixture.LoadTogether(root, library)
            let checks = assemblies[1].GetType("ConstructedEquality.Checks") ??
                throw InvalidOperationException("Missing constructed checks.")
            let method = checks.GetMethod("Compare") ??
                throw InvalidOperationException("Missing constructed comparison.")
            let instructions = IlInstructionReader.Read(
                method.GetMethodBody()?.GetILAsByteArray() ??
                    throw InvalidOperationException("Missing constructed comparison body.")
            )
            let equality = Assert.Single(
                instructions,
                (instruction IlInstruction) -> instruction.MetadataToken is int32 token && method.Module.ResolveMethod(
                    token,
                    nil,
                    method.GetGenericArguments()
                ) is {} target &&
                    target.Name == "Equals"
            )
            Assert.Equal(
                if path == "methodgroup" {
                    OpCodes.Ldvirtftn
                } else {
                    OpCodes.Callvirt
                },
                equality.OpCode
            )
            let equalityTarget = method.Module.ResolveMethod(
                equality.MetadataToken ?? throw InvalidOperationException("Missing equality token."),
                nil,
                method.GetGenericArguments()
            ) ??
                throw InvalidOperationException("Missing equality target.")
            let owner = equalityTarget.DeclaringType ?? throw InvalidOperationException("Missing equality owner.")
            Assert.Equal("Root`1", owner.Name)
            Assert.Equal([]Type{typeof(string)}, owner.GetGenericArguments())
            Assert.Equal(owner, Assert.Single(equalityTarget.GetParameters()).ParameterType)
            using let references = ReferenceResolver.WithReferences(
                ReferenceResolver.HostTrustedPlatformAssemblyPaths().Append(root).ToArray()
            )
            let compilation = GSharp
                .Core
                .CodeAnalysis
                .Compilation
                .Compilation(references, GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(source)){IsLibrary = true}
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            let middle = Assert.Single(compilation.GlobalScope.Structs, (type StructSymbol) -> type.Name == "Middle")
            let inheritedRoot = middle.BaseClass ?? throw InvalidOperationException("Missing constructed source base.")
            Assert.NotSame(inheritedRoot.Definition, inheritedRoot)
            Assert.Contains(
                inheritedRoot.DataEqualsSelf,
                TypeMemberModel.GetMethods(middle, "Equals", MemberQuery(true, false, true, MemberKinds.Method))
            )
        } finally {
            PreserveEvidence(fixture.Directory, "constructed-$genericReceiver-$path")
        }
    }

    @Theory
    @InlineData(false, false, "self")
    @InlineData(true, false, "self")
    @InlineData(false, false, "base")
    @InlineData(true, false, "base")
    @InlineData(false, true, "both")
    @InlineData(true, true, "both")
    func ImportedOrdinaryClass_DomainEqualityIsNotARecordSlot(generic bool, final bool, path string) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        using let fixture = NativeSliceLanguageTests.Fixture()
        try {
            let nativeRoot = if generic {
                "Root<T>"
            } else {
                "Root"
            }
            let nativeLeaf = if generic {
                "Leaf<T>"
            } else {
                "Leaf"
            }
            let closedRoot = if generic {
                "Root<string>"
            } else {
                "Root"
            }
            let closedLeaf = if generic {
                "Leaf<string>"
            } else {
                "Leaf"
            }
            let gsRoot = if generic {
                "Root[T]"
            } else {
                "Root"
            }
            let gsLeaf = if generic {
                "Leaf[T any]"
            } else {
                "Leaf"
            }
            let gsSelf = if generic {
                "Leaf[T]"
            } else {
                "Leaf"
            }
            let source = (`package OrdinaryEquality
import System
public data class ` + "$gsLeaf" + `(Extra int32) : ` + "$gsRoot" + `(0), IEquatable[` + "$gsSelf" + `]`)
            let root = CompileNative(fixture.Directory, "RootContracts", (`using System;
namespace OrdinaryEquality;
public class Domain<T> {
    public virtual bool Equals(T? other) => false;
}
public class ` + "$nativeRoot" + ` : Domain<` + "$nativeRoot" + `>, IEquatable<` + "$nativeRoot" + `> {
    public static int Calls;
    public int Tag;
    public Root(int tag) => Tag = tag;
    protected Root(` + "$nativeRoot" + ` original) => Tag = original.Tag;
    public ` + "${(if final { "sealed override" } else { "override" })}" + ` bool Equals(` + "$nativeRoot" + `? other) {
        Calls++;
        return other != null && Tag == other.Tag;
    }
}`))
            let reference = Path.Combine(fixture.Directory, "Contracts.ref.dll")
            File.WriteAllText(
                Path.Combine(fixture.Directory, "gsc-invocation.json"),
                JsonSerializer.Serialize(
                    AnonymousType6_52711CDFEDA9EBD9(
                        "GSharp.Compiler.Program.Main",
                        typeof(Program).Assembly.Location,
                        Hash(typeof(Program).Assembly.Location),
                        typeof(TypeSymbol).Assembly.Location,
                        Hash(typeof(TypeSymbol).Assembly.Location),
                        []string{
                            "/out:" + Path.Combine(fixture.Directory, "Contracts.dll"),
                            "/target:library",
                            "/targetframework:net10.0",
                            Path.Combine(fixture.Directory, "Contracts.gs"),
                            "/assemblyname:Contracts",
                            "/r:" + root,
                            "/refout:" + reference,
                            "/debug:portable"
                        }
                    )
                )
            )
            let library = fixture.Compile(
                source,
                "Contracts",
                executable: false,
                "/assemblyname:Contracts",
                "/r:" + root,
                "/refout:" + reference,
                "/debug:portable"
            )
            let nativeDirectory = Path.Combine(fixture.Directory, "native")
            Directory.CreateDirectory(nativeDirectory)
            let native = CompileNative(nativeDirectory, "Contracts", (`using System;
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
namespace OrdinaryEquality;
public sealed class ` + "$nativeLeaf" + ` : ` + "$nativeRoot" + `, IEquatable<` + "$nativeLeaf" + `> {
    public int Extra { get; }
    public Leaf(int extra) : base(0) => Extra = extra;
    public bool Equals(` + "$nativeLeaf" + `? other) =>
        other != null && GetType() == other.GetType() && Extra == other.Extra;
    public override bool Equals(object? other) => other is ` + "$nativeLeaf" + ` leaf && Equals(leaf);
    public override int GetHashCode() => Extra;
    public static bool operator ==(` + "$nativeLeaf" + `? left, ` + "$nativeLeaf" + `? right) =>
        ReferenceEquals(left, right) || left is not null && left.Equals(right);
    public static bool operator !=(` + "$nativeLeaf" + `? left, ` + "$nativeLeaf" + `? right) => !(left == right);
}`), root)
            let consumer = CompileNative(fixture.Directory, "Consumer", (`using System;
using System.Collections.Generic;
using OrdinaryEquality;
public static class Consumer {
    public static string Run(string path) {
        var first = new ` + "$closedLeaf" + `(7) { Tag = 41 };
        var inherited = new ` + "$closedLeaf" + `(7) { Tag = 42 };
        var derived = new ` + "$closedLeaf" + `(8) { Tag = 41 };
        var same = new ` + "$closedLeaf" + `(7) { Tag = 41 };
        ` + "$closedRoot" + ` receiver = first;
        Func<` + "$closedLeaf" + `?, bool> selfGroup = first.Equals;
        Func<object?, bool> objectGroup = first.Equals;
        Func<` + "$closedRoot" + `?, bool> baseGroup = receiver.Equals;
        if (path != "base") {
            ` + "$closedRoot" + `.Calls = 0;
            foreach (var (other, equal) in new[] { (inherited, true), (derived, false), (same, true) })
                foreach (var result in new[] {
                    first.Equals(other), ((object)first).Equals(other),
                    ((IEquatable<` + "$closedLeaf" + `>)first).Equals(other),
                    selfGroup(other), objectGroup(other),
                    EqualityComparer<` + "$closedLeaf" + `>.Default.Equals(first, other),
                    first == other, !(first != other)
                })
                    if (result != equal) throw new Exception("ordinary self structural path");
            if (` + "$closedRoot" + `.Calls != 0) throw new Exception("ordinary self invoked domain equality");
            if (first.Equals((` + "$closedLeaf" + `?)null) || selfGroup(null) || objectGroup(null)
                || first == null || null == first || !(first != null))
                throw new Exception("ordinary self null control");
        }
        if (path != "self") {
            ` + "$closedRoot" + `.Calls = 0;
            foreach (var (other, equal) in new[] {
                (inherited, false), (derived, true), (same, true), ((` + "$closedLeaf" + `?)null, false)
            })
                foreach (var result in new[] {
                    receiver.Equals(other),
                    ((IEquatable<` + "$closedRoot" + `>)first).Equals(other),
                    baseGroup(other),
                    EqualityComparer<` + "$closedRoot" + `>.Default.Equals(first, other)
                })
                    if (result != equal) throw new Exception("ordinary base domain path");
            // EqualityComparer handles null without invoking the domain slot.
            if (` + "$closedRoot" + `.Calls != 15) throw new Exception("ordinary base domain call count:" + ` + "$closedRoot" + `.Calls);
        }
        ` + "$closedLeaf" + `? absent = null;
        if (!(absent == null) || absent != null || first.Tag != 41 || first.Extra != 7)
            throw new Exception("ordinary null/state control");
        return "ordinary:" + path + ":structural/domain/null/state";
    }
}`), root, reference)
            for image in[]string{root, native, library} {
                IlVerifier.Verify(image, []string{root})
            }
            IlVerifier.Verify(consumer, []string{root, native})
            IlVerifier.Verify(consumer, []string{root, library})
            let expected = "ordinary:" + path + ":structural/domain/null/state"
            Assert.Equal(expected, RunConsumer(root, native, consumer, path))
            Assert.Equal(expected, RunConsumer(root, library, consumer, path))
            this.output.WriteLine("SAME ordinary native consumer SHA256=" + Hash(consumer))
            let assemblies = EmittedFixture.LoadTogether(root, library)
            var leaf = assemblies[1].GetType(
                "OrdinaryEquality.Leaf" +
                    (
                    if generic {
                        "`1"
                    } else {
                        ""
                    }
                )
            ) ??
                throw InvalidOperationException("Missing ordinary leaf.")
            if generic {
                leaf = leaf.MakeGenericType(typeof(string))
            }
            let directBase = leaf.BaseType ?? throw InvalidOperationException("Missing ordinary base.")
            let inheritedSlot = leaf.GetMethod("Equals", []Type{directBase}) ??
                throw InvalidOperationException("Missing domain equality.")
            Assert.Equal(directBase, inheritedSlot.DeclaringType)
            Assert.Equal(final, inheritedSlot.IsFinal)
            Assert.Equal(
                directBase,
                leaf
                    .GetInterfaceMap(typeof(IEquatable[_]).MakeGenericType(directBase))
                    .TargetMethods
                    .Single()
                    .DeclaringType
            )
            let selfEquals = leaf.GetMethod("Equals", []Type{leaf}) ??
                throw InvalidOperationException("Missing ordinary self equality.")
            Assert.True(selfEquals.IsFinal)
            Assert.DoesNotContain(
                IlInstructionReader.Read(
                    selfEquals.GetMethodBody()?.GetILAsByteArray() ??
                        throw InvalidOperationException("Missing ordinary equality body.")
                ),
                (instruction IlInstruction) -> instruction.MetadataToken is int32 token &&
                    selfEquals
                    .Module
                    .ResolveMethod(token, leaf.GetGenericArguments(), nil) is {} target &&
                    target.Name == "Equals" &&
                    target.DeclaringType == directBase
            )
            Assert.Equal(EqualityRows(library, expectedCount: 2), EqualityRows(reference, expectedCount: 2))
            using let references = ReferenceResolver.WithReferences(
                ReferenceResolver.HostTrustedPlatformAssemblyPaths().Append(root).ToArray()
            )
            let compilation = GSharp
                .Core
                .CodeAnalysis
                .Compilation
                .Compilation(references, GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(source)){IsLibrary = true}
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            let symbol = Assert.Single(compilation.GlobalScope.Structs, (type StructSymbol) -> type.Name == "Leaf")
            let query = MemberQuery(true, false, false, MemberKinds.Method)
            Assert.Null(symbol.DataEqualsBase)
            Assert.Equal(2, symbol.GetMethods("Equals").Length)
            Assert.Equal[FunctionSymbol](
                symbol.GetMethods("Equals"),
                TypeMemberModel.GetMethods(symbol, "Equals", query)
            )
        } finally {
            PreserveEvidence(fixture.Directory, "ordinary-$generic-$final-$path")
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedRecord_OptionalParameterNamePreservesSignatureAndDispatch(unnamed bool) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        using let fixture = NativeSliceLanguageTests.Fixture()
        try {
            let root = CompileNative(fixture.Directory, "RootContracts", `namespace OptionalName;
public record Root<T> {
    public int Tag;
    public Root(int tag) => Tag = tag;
}`)
            if unnamed {
                ClearTypedEqualsParameterName(root)
            }
            let reference = Path.Combine(fixture.Directory, "Contracts.ref.dll")
            let library = fixture.Compile(`package OptionalName
import System
public data class Leaf[T any](Extra int32) : Root[T](0), IEquatable[Leaf[T]]`, "Contracts", executable: false, "/assemblyname:Contracts", "/r:" +
                    root, "/refout:" + reference, "/debug:portable")
            let nativeDirectory = Path.Combine(fixture.Directory, "native")
            Directory.CreateDirectory(nativeDirectory)
            let native = CompileNative(nativeDirectory, "Contracts", `[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
namespace OptionalName;
public sealed record Leaf<T>(int Extra) : Root<T>(0);`, root)
            let consumer = CompileNative(fixture.Directory, "Consumer", `using System;
using OptionalName;
public static class Consumer {
    public static string Run(string ignored) {
        var first = new Leaf<string>(7) { Tag = 41 };
        var same = new Leaf<string>(7) { Tag = 41 };
        var inherited = new Leaf<string>(7) { Tag = 42 };
        var derived = new Leaf<string>(8) { Tag = 41 };
        Root<string> receiver = first;
        Func<Root<string>?, bool> equals = receiver.Equals;
        foreach (var different in new[] { inherited, derived })
            if (first.Equals(different) || receiver.Equals(different)
                || ((object)first).Equals(different)
                || ((IEquatable<Root<string>>)first).Equals(different)
                || ((IEquatable<Leaf<string>>)first).Equals(different)
                || equals(different) || first == different || !(first != different))
                throw new Exception("optional-name difference");
        if (!first.Equals(same) || !receiver.Equals(same) || !equals(same)
            || first.Equals((Leaf<string>?)null) || equals(null))
            throw new Exception("optional-name equal/null control");
        return "optional-name/equal/inherited/derived/null";
    }
}`, root, reference)
            for image in[]string{root, native, library} {
                IlVerifier.Verify(image, []string{root})
            }
            IlVerifier.Verify(consumer, []string{root, native})
            IlVerifier.Verify(consumer, []string{root, library})
            Assert.Equal("optional-name/equal/inherited/derived/null", RunConsumer(root, native, consumer, ""))
            Assert.Equal("optional-name/equal/inherited/derived/null", RunConsumer(root, library, consumer, ""))
            let assemblies = EmittedFixture.LoadTogether(root, library)
            let leaf = (
                assemblies[1].GetType("OptionalName.Leaf`1") ??
                    throw InvalidOperationException("Missing optional-name leaf.")
            ).MakeGenericType(typeof(string))
            let directBase = leaf.BaseType ?? throw InvalidOperationException("Missing optional-name base.")
            let slot = leaf.GetMethod("Equals", []Type{directBase}) ??
                throw InvalidOperationException("Missing optional-name override.")
            let parameter = Assert.Single(slot.GetParameters())
            Assert.Equal(
                if unnamed {
                    "arg0"
                } else {
                    "other"
                },
                parameter.Name
            )
            Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(parameter).ReadState)
            Assert.Equal(directBase, slot.GetBaseDefinition().DeclaringType)
            Assert.Equal(EqualityRows(library), EqualityRows(reference))
        } finally {
            PreserveEvidence(
                fixture.Directory,
                if unnamed {
                    "optional-unnamed"
                } else {
                    "optional-named"
                }
            )
        }
    }

    @Theory
    @InlineData(false, "inherited")
    @InlineData(false, "derived")
    @InlineData(false, "equal")
    @InlineData(true, "inherited")
    @InlineData(true, "derived")
    @InlineData(true, "equal")
    func NativeConsumer_ImportedSymbolicBasePreservesBothFieldSets(reordered bool, difference string) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        using let fixture = NativeSliceLanguageTests.Fixture()
        try {
            let root = CompileNative(fixture.Directory, "RootContracts", `namespace ImportedEquality;
public record Root<T> {
    public int Tag;
    public T? Value;
    public Root(int tag) => Tag = tag;
}
public record Reordered<A, B> : Root<B> {
    public A? Owner;
    public Reordered(int tag) : base(tag) { }
}`)
            let declaration = if reordered {
                "Leaf[T any, U any]"
            } else {
                "Leaf[T any]"
            }
            let baseType = if reordered {
                "Reordered[U, T]"
            } else {
                "Root[T]"
            }
            let selfType = if reordered {
                "Leaf[T, U]"
            } else {
                "Leaf[T]"
            }
            let closedLeaf = if reordered {
                "Leaf<string, int>"
            } else {
                "Leaf<string>"
            }
            let closedBase = if reordered {
                "Reordered<int, string>"
            } else {
                "Root<string>"
            }
            let nativeDeclaration = if reordered {
                "Leaf<T, U>"
            } else {
                "Leaf<T>"
            }
            let nativeBase = if reordered {
                "Reordered<U, T>"
            } else {
                "Root<T>"
            }
            let reference = Path.Combine(fixture.Directory, "Contracts.ref.dll")
            File.WriteAllText(
                Path.Combine(fixture.Directory, "gsc-invocation.json"),
                JsonSerializer.Serialize(
                    AnonymousType6_52711CDFEDA9EBD9(
                        "GSharp.Compiler.Program.Main",
                        typeof(Program).Assembly.Location,
                        Hash(typeof(Program).Assembly.Location),
                        typeof(TypeSymbol).Assembly.Location,
                        Hash(typeof(TypeSymbol).Assembly.Location),
                        []string{
                            "/out:" + Path.Combine(fixture.Directory, "Contracts.dll"),
                            "/target:library",
                            "/targetframework:net10.0",
                            Path.Combine(fixture.Directory, "Contracts.gs"),
                            "/assemblyname:Contracts",
                            "/r:" + root,
                            "/refout:" + reference,
                            "/debug:portable"
                        }
                    )
                )
            )
            let library = fixture.Compile((`package ImportedEquality
import System
public data class ` + "$declaration" + `(Extra int32) : ` + "$baseType" + `(0), IEquatable[` + "$selfType" + `]`), "Contracts", executable: false, "/assemblyname:Contracts", "/r:" +
                    root, "/refout:" + reference, "/debug:portable")
            let nativeDirectory = Path.Combine(fixture.Directory, "native")
            Directory.CreateDirectory(nativeDirectory)
            let native = CompileNative(nativeDirectory, "Contracts", (`[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
namespace ImportedEquality;
public sealed record ` + "$nativeDeclaration" + `(int Extra) : ` + "$nativeBase" + `(0);`), root)
            let consumer = CompileNative(fixture.Directory, "Consumer", (`using System;
using System.Collections.Generic;
using ImportedEquality;
public static class Consumer {
    public static string Run(string difference) {
        var first = new ` + "$closedLeaf" + `(7) { Tag = 41, Value = "base-value" };
        var second = new ` + "$closedLeaf" + `(difference == "derived" ? 8 : 7) {
            Tag = difference == "inherited" ? 42 : 41, Value = "base-value"
        };
        bool equal = difference == "equal";
        Root<string> receiver = first;
        ` + "$closedBase" + ` direct = first;
        Func<Root<string>?, bool> baseGroup = receiver.Equals;
        Func<` + "$closedBase" + `?, bool> directGroup = direct.Equals;
        Func<` + "$closedLeaf" + `?, bool> selfGroup = first.Equals;
        Func<object?, bool> objectGroup = first.Equals;
        bool[] comparisons = {
            first.Equals(second), ((object)first).Equals(second),
            receiver.Equals(second), ((IEquatable<Root<string>>)first).Equals(second),
            ((IEquatable<` + "$closedLeaf" + `>)first).Equals(second),
            baseGroup(second), selfGroup(second), objectGroup(second),
            EqualityComparer<Root<string>>.Default.Equals(first, second),
            first == second, !(first != second),
            direct.Equals(second), ((IEquatable<` + "$closedBase" + `>)first).Equals(second),
            directGroup(second)
        };
        for (int i = 0; i < comparisons.Length; i++)
            if (comparisons[i] != equal) throw new Exception(difference + ":path" + i);
        if (first.Equals((` + "$closedLeaf" + `?)null) || receiver.Equals(null)
            || baseGroup(null) || directGroup(null) || selfGroup(null) || objectGroup(null)
            || first == null || null == first || !(first != null))
            throw new Exception("null control");
        ` + "$closedLeaf" + `? absent = null;
        if (!(absent == null) || absent != null) throw new Exception("null operator control");
        if (first.Tag != 41 || first.Extra != 7 || first.Value != "base-value")
            throw new Exception("field control");
        return difference + ":14-dispatch/null/field-controls";
    }
}`), root, reference)
            for image in[]string{root, native, library} {
                IlVerifier.Verify(image, []string{root})
            }
            IlVerifier.Verify(consumer, []string{root, native})
            IlVerifier.Verify(consumer, []string{root, library})
            let expected = difference + ":14-dispatch/null/field-controls"
            Assert.Equal(expected, RunConsumer(root, native, consumer, difference))
            Assert.Equal(expected, RunConsumer(root, library, consumer, difference))
            this.output.WriteLine("SAME native consumer SHA256=" + Hash(consumer))
            this.output.WriteLine("gsc image SHA256=" + Hash(library))
            if difference == "equal" {
                return
            }
            let assemblies = EmittedFixture.LoadTogether(root, library)
            var leaf = assemblies[1].GetTypes().Single(
                (type Type) -> type.Name.StartsWith("Leaf`", StringComparison.Ordinal)
            )
            leaf = leaf.MakeGenericType(
                if reordered {
                    []Type{typeof(string), typeof(int32)}
                } else {
                    []Type{typeof(string)}
                }
            )
            let directBase = leaf.BaseType ?? throw InvalidOperationException("Missing direct base.")
            let slot = leaf.GetMethod(
                "Equals",
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly,
                nil,
                []Type{directBase},
                nil
            ) ??
                throw InvalidOperationException("Missing imported typed-base override.")
            Assert.True(slot.IsVirtual && slot.IsFinal)
            Assert.Equal(0, int32((slot.Attributes & MethodAttributes.NewSlot)))
            Assert.Equal(directBase, slot.GetBaseDefinition().DeclaringType)
            let parameter = Assert.Single(slot.GetParameters())
            Assert.Equal("other", parameter.Name)
            Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(parameter).ReadState)
            if reordered {
                Assert.Equal([]Type{typeof(int32), typeof(string)}, directBase.GetGenericArguments())
            }
            let selfEquals = leaf.GetMethod("Equals", []Type{leaf}) ??
                throw InvalidOperationException("Missing self equality.")
            let instructions = IlInstructionReader.Read(
                selfEquals.GetMethodBody()?.GetILAsByteArray() ??
                    throw InvalidOperationException("Missing self equality body.")
            )
            let baseCall = Assert.Single(
                instructions,
                (instruction IlInstruction) -> instruction.MetadataToken is int32 token &&
                    selfEquals
                    .Module
                    .ResolveMethod(token, leaf.GetGenericArguments(), nil) is {} target &&
                    target.Name == "Equals" &&
                    target.DeclaringType == directBase
            )
            Assert.Equal(OpCodes.Call, baseCall.OpCode)
            Assert.Equal(EqualityRows(library), EqualityRows(reference))
        } finally {
            PreserveEvidence(
                fixture.Directory,
                (
                    if reordered {
                        "reordered-"
                    } else {
                        "generic-"
                    }
                ) +
                    difference
            )
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceOnlyBase_OrdinaryAndGenericDispatchRemainStructural(generic bool) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        using let fixture = NativeSliceLanguageTests.Fixture()
        try {
            let root = if generic {
                "Root[T any]"
            } else {
                "Root"
            }
            let leaf = if generic {
                "Leaf[T any]"
            } else {
                "Leaf"
            }
            let baseType = if generic {
                "Root[T]"
            } else {
                "Root"
            }
            let closed = if generic {
                "Leaf[string]"
            } else {
                "Leaf"
            }
            let library = fixture.Compile((`package SourceEquality
import System
public open data class ` + "$root" + `(Tag int32)
public data class ` + "$leaf" + `(Tag int32, Extra int32) : ` + "$baseType" + `(Tag)
public func Check() bool {
    let first = ` + "$closed" + `(41, 7)
    let same = ` + "$closed" + `(41, 7)
    let inherited = ` + "$closed" + `(42, 7)
    let derived = ` + "$closed" + `(41, 8)
    let receiver ` + "${(if generic { "Root[string]" } else { "Root" })}" + ` = first
    let equals Func[` + "${(if generic { "Root[string]" } else { "Root" })}" + `?, bool] = receiver.Equals
    return first.Equals(same) && !first.Equals(inherited) && !first.Equals(derived)
        && receiver.Equals(same) && !receiver.Equals(inherited) && !receiver.Equals(derived)
        && equals(same) && !equals(inherited) && !equals(derived) && !equals(nil)
        && first == same && first != inherited && first != derived
}`), "SourceControls", executable: false)
            IlVerifier.Verify(library)
            let check = EmittedFixture
                .Load(library)
                .GetTypes()
                .SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(BindingFlags.Public | BindingFlags.Static)
                }
            )
                .Single((method MethodInfo) -> method.Name == "Check")
            Assert.Equal(true, check.Invoke(nil, nil))
        } finally {
            PreserveEvidence(
                fixture.Directory,
                if generic {
                    "source-generic"
                } else {
                    "source-ordinary"
                }
            )
        }
    }

    shared {
        private func ClearTypedEqualsParameterName(path string) {
            let original = File.ReadAllBytes(path)
            let type = EmittedFixture.Load(original).GetType("OptionalName.Root`1") ??
                throw InvalidOperationException("Missing native root.")
            let slot = type.GetMethod("Equals", []Type{type}) ??
                throw InvalidOperationException("Missing native typed slot.")
            using let pe = PEReader(MemoryStream(original))
            let metadata = pe.GetMetadataReader()
            let method = metadata.GetMethodDefinition(
                MetadataTokens.MethodDefinitionHandle(slot.MetadataToken & 0xFFFFFF)
            )
            let parameterHandle = Assert.Single(
                method.GetParameters(),
                (handle ParameterHandle) -> metadata.GetParameter(handle).SequenceNumber == 1
            )
            let rowSize = metadata.GetTableRowSize(TableIndex.Param)
            let offset = pe.PEHeaders.MetadataStartOffset + metadata.GetTableMetadataOffset(TableIndex.Param) +
                ((MetadataTokens.GetRowNumber(parameterHandle) - 1) * rowSize) +
                4
            let mutated = cast[[]uint8](original.Clone())
            Array.Clear(mutated, offset, rowSize - 4)
            let differences = Enumerable
                .Range(0, original.Length)
                .Where((i int32) -> original[i] != mutated[i])
                .ToArray()
            Assert.NotEmpty(differences)
            Assert.All(differences, (index int32) -> Assert.InRange(index, offset, offset + rowSize - 5))
            File.WriteAllBytes(path + ".named-original", original)
            File.WriteAllText(
                path + ".name-mutation.json",
                JsonSerializer.Serialize(
                    AnonymousType7_EE10BD759CCAF2CD(
                        offset,
                        rowSize - 4,
                        differences,
                        Convert.ToHexString(SHA256.HashData(original)),
                        Convert.ToHexString(SHA256.HashData(mutated)),
                        slot.Module.ModuleVersionId,
                        slot.MetadataToken
                    )
                )
            )
            File.WriteAllBytes(path, mutated)
        }

        private func CompileNative(directory string, name string, source string, references ...string) string {
            let sourcePath = Path.Combine(directory, name + ".cs")
            let imagePath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source, Encoding.UTF8)
            let referencePaths = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Concat(references).ToArray()
            File.WriteAllText(
                sourcePath + ".inputs.json",
                JsonSerializer.Serialize(
                    AnonymousType12_B8E3A8878AFB1940(
                        "Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create/Emit",
                        sourcePath,
                        Hash(sourcePath),
                        imagePath,
                        Path.ChangeExtension(imagePath, ".pdb"),
                        "DynamicallyLinkedLibrary",
                        "Enable",
                        true,
                        "PortablePdb",
                        typeof(CSharpCompilation).Assembly.Location,
                        Hash(typeof(CSharpCompilation).Assembly.Location),
                        referencePaths.Select((path string) -> AnonymousType2_2852AB3CCB00A7ED(path, Hash(path)))
                    )
                )
            )
            let compilation = CSharpCompilation.Create(
                name,
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{
                    CSharpSyntaxTree.ParseText(
                        SourceText.From(source, Encoding.UTF8, SourceHashAlgorithm.Sha256),
                        path: sourcePath
                    )
                },
                referencePaths.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable,
                    deterministic: true
                )
            )
            using let image = File.Create(imagePath)
            using let pdb = File.Create(Path.ChangeExtension(imagePath, ".pdb"))
            let result = compilation.Emit(
                image,
                pdb,
                options: EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb)
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            Assert.True(pdb.Length > int64(0))
            return imagePath
        }

        private func RunConsumer(root string, library string, consumer string, difference string) object? {
            let assemblies = EmittedFixture.LoadTogether(root, library, consumer)
            return (
                assemblies[2].GetType("Consumer")?.GetMethod("Run") ??
                    throw InvalidOperationException("Missing native consumer.")
            ).Invoke(nil, []object{difference})
        }

        private func EqualityRows(path string, expectedCount int32 = 3)[]string {
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let metadata = pe.GetMetadataReader()
            let rows = metadata
                .TypeDefinitions
                .SelectMany(
                func (handle TypeDefinitionHandle) IEnumerable[MethodDefinitionHandle] {
                    return metadata.GetTypeDefinition(handle).GetMethods()
                }
            )
                .Select((handle MethodDefinitionHandle) -> metadata.GetMethodDefinition(handle))
                .Where((method MethodDefinition) -> metadata.GetString(method.Name) == "Equals")
                .Select(
                (method MethodDefinition) -> (
                    method.Attributes.ToString() + "|" + Convert.ToHexString(metadata.GetBlobBytes(method.Signature)) +
                        "|" +
                        string
                        .Join(
                        ";",
                        method.GetParameters().Select(
                            (handle ParameterHandle) -> {
                                let parameter = metadata.GetParameter(handle)
                                return metadata.GetString(parameter.Name) + ":" + string.Join(
                                    ",",
                                    parameter.GetCustomAttributes().Select(
                                        (attribute CustomAttributeHandle) -> Convert.ToHexString(
                                            metadata.GetBlobBytes(metadata.GetCustomAttribute(attribute).Value)
                                        )
                                    )
                                )
                            }
                        )
                    )
                )
            )
                .ToArray()
            Assert.Equal(expectedCount, rows.Length)
            let implementations = metadata
                .TypeDefinitions
                .SelectMany(
                func (handle TypeDefinitionHandle) IEnumerable[MethodImplementationHandle] {
                    return metadata.GetTypeDefinition(handle).GetMethodImplementations()
                }
            )
                .Select((handle MethodImplementationHandle) -> metadata.GetMethodImplementation(handle))
                .Where(
                (implementation MethodImplementation) -> implementation
                    .MethodDeclaration
                    .Kind == HandleKind.MemberReference
            )
                .Select(
                (implementation MethodImplementation) -> metadata.GetMemberReference(
                    MemberReferenceHandle(implementation.MethodDeclaration)
                )
            )
                .Where((member MemberReference) -> metadata.GetString(member.Name) == "Equals")
                .ToArray()
            if expectedCount == 2 {
                Assert.Empty(implementations)
            } else {
                Assert.NotEmpty(implementations)
                Assert.Contains(
                    implementations,
                    (member MemberReference) -> member.Parent.Kind == HandleKind.TypeSpecification
                )
            }
            return rows
        }

        private func Hash(path string) string -> Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))

        private func PreserveEvidence(directory string, name string) {
            let root string? = Environment.GetEnvironmentVariable("GSHARP_4778_EVIDENCE_ROOT")
            if string.IsNullOrEmpty(root) {
                return
            }
            let destination = Path.Combine(root, name)
            for path in Directory.GetFiles(directory, "*", SearchOption.AllDirectories) {
                let target = Path.Combine(destination, Path.GetRelativePath(directory, path))
                Directory.CreateDirectory(
                    Path.GetDirectoryName(target) ?? throw InvalidOperationException("Missing evidence directory.")
                )
                File.Copy(path, target, overwrite: true)
            }
        }
    }
}

internal data class AnonymousType6_52711CDFEDA9EBD9(
    entry string,
    compiler string,
    compilerSha256 string,
    core string,
    coreSha256 string,
    argv[]string?
) { }

internal data class AnonymousType6_72319ECD357A6A9B(
    path string,
    genericReceiver bool,
    consumerSha256 string,
    nativeResult object?,
    gsharpResult object?,
    expected string
) { }

internal data class AnonymousType7_EE10BD759CCAF2CD(
    offset int32,
    stringIndexWidth int32,
    changedOffsets[]int32,
    originalSha256 string,
    mutatedSha256 string,
    mvid Guid,
    token int32
) { }

internal data class AnonymousType2_2852AB3CCB00A7ED(path string, sha256 string) { }

internal data class AnonymousType12_B8E3A8878AFB1940(
    entry string,
    sourcePath string,
    sourceSha256 string,
    imagePath string,
    pdbPath string,
    outputKind string,
    nullableContext string,
    deterministic bool,
    debugInformationFormat string,
    roslyn string,
    roslynSha256 string,
    references IEnumerable[AnonymousType2_2852AB3CCB00A7ED?]
) { }
