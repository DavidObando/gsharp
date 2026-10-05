// <copyright file="Issue4777ImportedRecordEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Imported direct record equality uses the same base contract as source inheritance.</summary>
public sealed class Issue4777ImportedRecordEqualityTests
{
    private readonly ITestOutputHelper output;

    public Issue4777ImportedRecordEqualityTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Theory]
    [InlineData(false, "ordinary")]
    [InlineData(true, "ordinary")]
    [InlineData(false, "constrained")]
    [InlineData(true, "constrained")]
    [InlineData(false, "methodgroup")]
    [InlineData(true, "methodgroup")]
    public void ConstructedSourceBase_OrdinaryCallsAndGroupsUseDeclaringEquality(bool genericReceiver, string path)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        using var fixture = new NativeSliceLanguageTests.Fixture();
        try
        {
            var receiver = genericReceiver ? "Middle[string]" : "Closed";
            var nativeReceiver = genericReceiver ? "Middle<string>" : "Closed";
            var constrained = path == "constrained";
            var comparison = path == "methodgroup"
                ? "let equals Func[Root[string]?, bool] = left.Equals\nreturn NativeOracle.Observe(equals(right), expected)"
                : "return NativeOracle.Observe(left.Equals(right), expected)";
            var root = CompileNative(fixture.Directory, "NativeOracle", """
                using System;
                namespace ConstructedEquality;
                public static class NativeOracle {
                    public static int Calls;
                    public static bool Observe(bool actual, bool expected) {
                        Calls++;
                        if (actual != expected) throw new Exception("constructed inherited equality");
                        return actual;
                    }
                }
                """);
            var source = $$"""
                package ConstructedEquality
                import System
                public open data class Root[T any](Tag int32) : IEquatable[Root[T]]
                public open class Middle[T any](State int32) : Root[T](0) {
                    public func ReadState() int32 -> State
                }
                public open class Closed(State int32) : Middle[string](State)
                public class Checks {
                    shared {
                        public func Compare{{(constrained ? "[U " + receiver + "]" : "")}}(
                            left {{(constrained ? "U" : receiver)}}, right Root[string]?, expected bool) bool {
                            {{comparison}}
                        }
                    }
                }
                """;
            var reference = Path.Combine(fixture.Directory, "Contracts.ref.dll");
            File.WriteAllText(Path.Combine(fixture.Directory, "gsc-invocation.json"), JsonSerializer.Serialize(new
            {
                entry = "GSharp.Compiler.Program.Main",
                compiler = typeof(Program).Assembly.Location,
                compilerSha256 = Hash(typeof(Program).Assembly.Location),
                core = typeof(TypeSymbol).Assembly.Location,
                coreSha256 = Hash(typeof(TypeSymbol).Assembly.Location),
                argv = new[]
                {
                    "/out:" + Path.Combine(fixture.Directory, "Contracts.dll"),
                    "/target:library", "/targetframework:net10.0",
                    Path.Combine(fixture.Directory, "Contracts.gs"),
                    "/assemblyname:Contracts", "/r:" + root, "/refout:" + reference, "/debug:portable",
                },
            }));
            var library = fixture.Compile(source, "Contracts", executable: false,
                "/assemblyname:Contracts", "/r:" + root, "/refout:" + reference, "/debug:portable");
            var nativeDirectory = Path.Combine(fixture.Directory, "native");
            Directory.CreateDirectory(nativeDirectory);
            // C# records cannot have an ordinary class descendant; this native CLR oracle
            // spells the same root equality contract explicitly for that legal G# shape.
            var native = CompileNative(nativeDirectory, "Contracts", $$"""
                using System;
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
                    public static bool Compare{{(constrained ? "<U>" : "")}}(
                        {{(constrained ? "U" : nativeReceiver)}} left, Root<string>? right, bool expected)
                        {{(constrained ? "where U : " + nativeReceiver : "")}} {
                        {{(path == "methodgroup"
                            ? "Func<Root<string>?, bool> equals = left.Equals;\nreturn NativeOracle.Observe(equals(right), expected);"
                            : "return NativeOracle.Observe(left.Equals(right), expected);")}}
                    }
                }
                """, root);
            var consumer = CompileNative(fixture.Directory, "Consumer", $$"""
                using System;
                using ConstructedEquality;
                public static class Consumer {
                    public static string Run(string ignored) {
                        var first = new {{nativeReceiver}}(7) { Tag = 41 };
                        var same = new {{nativeReceiver}}(7) { Tag = 41 };
                        var inherited = new {{nativeReceiver}}(7) { Tag = 42 };
                        var ordinary = new {{nativeReceiver}}(8) { Tag = 41 };
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
                }
                """, root, reference);
            foreach (var image in new[] { root, native, library, reference })
            {
                IlVerifier.Verify(image, new[] { root });
            }

            IlVerifier.Verify(consumer, new[] { root, native });
            IlVerifier.Verify(consumer, new[] { root, library });
            var expected = "constructed/equal/inherited-difference/ordinary-state/null";
            var nativeResult = RunConsumer(root, native, consumer, path);
            var gsharpResult = RunConsumer(root, library, consumer, path);
            Assert.Equal(expected, nativeResult);
            Assert.Equal(expected, gsharpResult);
            File.WriteAllText(Path.Combine(fixture.Directory, "same-consumer-runtime.json"), JsonSerializer.Serialize(new
            {
                path, genericReceiver, consumerSha256 = Hash(consumer), nativeResult, gsharpResult, expected,
            }));
            this.output.WriteLine("SAME constructed native consumer SHA256=" + Hash(consumer));
            Assert.Equal(EqualityRows(library, expectedCount: 2), EqualityRows(reference, expectedCount: 2));
            var assemblies = EmittedFixture.LoadTogether(root, library);
            var checks = assemblies[1].GetType("ConstructedEquality.Checks")
                ?? throw new InvalidOperationException("Missing constructed checks.");
            var method = checks.GetMethod("Compare") ?? throw new InvalidOperationException("Missing constructed comparison.");
            var instructions = IlInstructionReader.Read(method.GetMethodBody()?.GetILAsByteArray()
                ?? throw new InvalidOperationException("Missing constructed comparison body."));
            var equality = Assert.Single(instructions, instruction =>
                instruction.MetadataToken is int token
                && method.Module.ResolveMethod(token, null, method.GetGenericArguments()) is { } target
                && target.Name == "Equals");
            Assert.Equal(path == "methodgroup" ? OpCodes.Ldvirtftn : OpCodes.Callvirt, equality.OpCode);
            var equalityTarget = method.Module.ResolveMethod(
                equality.MetadataToken ?? throw new InvalidOperationException("Missing equality token."),
                null, method.GetGenericArguments()) ?? throw new InvalidOperationException("Missing equality target.");
            var owner = equalityTarget.DeclaringType ?? throw new InvalidOperationException("Missing equality owner.");
            Assert.Equal("Root`1", owner.Name);
            Assert.Equal(new[] { typeof(string) }, owner.GetGenericArguments());
            Assert.Equal(owner, Assert.Single(equalityTarget.GetParameters()).ParameterType);
            using var references = ReferenceResolver.WithReferences(
                ReferenceResolver.HostTrustedPlatformAssemblyPaths().Append(root).ToArray());
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(
                references, GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(source)) { IsLibrary = true };
            Assert.Empty(compilation.GlobalScope.Diagnostics);
            var middle = Assert.Single(compilation.GlobalScope.Structs, type => type.Name == "Middle");
            var inheritedRoot = middle.BaseClass ?? throw new InvalidOperationException("Missing constructed source base.");
            Assert.NotSame(inheritedRoot.Definition, inheritedRoot);
            Assert.Contains(inheritedRoot.DataEqualsSelf, TypeMemberModel.GetMethods(
                middle, "Equals", new MemberQuery(true, false, true, MemberKinds.Method)));
        }
        finally
        {
            PreserveEvidence(fixture.Directory, $"constructed-{genericReceiver}-{path}");
        }
    }

    [Theory]
    [InlineData(false, false, "self")]
    [InlineData(true, false, "self")]
    [InlineData(false, false, "base")]
    [InlineData(true, false, "base")]
    [InlineData(false, true, "both")]
    [InlineData(true, true, "both")]
    public void ImportedOrdinaryClass_DomainEqualityIsNotARecordSlot(bool generic, bool final, string path)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        using var fixture = new NativeSliceLanguageTests.Fixture();
        try
        {
            var nativeRoot = generic ? "Root<T>" : "Root";
            var nativeLeaf = generic ? "Leaf<T>" : "Leaf";
            var closedRoot = generic ? "Root<string>" : "Root";
            var closedLeaf = generic ? "Leaf<string>" : "Leaf";
            var gsRoot = generic ? "Root[T]" : "Root";
            var gsLeaf = generic ? "Leaf[T any]" : "Leaf";
            var gsSelf = generic ? "Leaf[T]" : "Leaf";
            var source = $$"""
                package OrdinaryEquality
                import System
                public data class {{gsLeaf}}(Extra int32) : {{gsRoot}}(0), IEquatable[{{gsSelf}}]
                """;
            var root = CompileNative(fixture.Directory, "RootContracts", $$"""
                using System;
                namespace OrdinaryEquality;
                public class Domain<T> {
                    public virtual bool Equals(T? other) => false;
                }
                public class {{nativeRoot}} : Domain<{{nativeRoot}}>, IEquatable<{{nativeRoot}}> {
                    public static int Calls;
                    public int Tag;
                    public Root(int tag) => Tag = tag;
                    protected Root({{nativeRoot}} original) => Tag = original.Tag;
                    public {{(final ? "sealed override" : "override")}} bool Equals({{nativeRoot}}? other) {
                        Calls++;
                        return other != null && Tag == other.Tag;
                    }
                }
                """);
            var reference = Path.Combine(fixture.Directory, "Contracts.ref.dll");
            File.WriteAllText(Path.Combine(fixture.Directory, "gsc-invocation.json"), JsonSerializer.Serialize(new
            {
                entry = "GSharp.Compiler.Program.Main",
                compiler = typeof(Program).Assembly.Location,
                compilerSha256 = Hash(typeof(Program).Assembly.Location),
                core = typeof(TypeSymbol).Assembly.Location,
                coreSha256 = Hash(typeof(TypeSymbol).Assembly.Location),
                argv = new[]
                {
                    "/out:" + Path.Combine(fixture.Directory, "Contracts.dll"),
                    "/target:library", "/targetframework:net10.0",
                    Path.Combine(fixture.Directory, "Contracts.gs"),
                    "/assemblyname:Contracts", "/r:" + root, "/refout:" + reference, "/debug:portable",
                },
            }));
            var library = fixture.Compile(source, "Contracts", executable: false,
                "/assemblyname:Contracts", "/r:" + root, "/refout:" + reference, "/debug:portable");
            var nativeDirectory = Path.Combine(fixture.Directory, "native");
            Directory.CreateDirectory(nativeDirectory);
            var native = CompileNative(nativeDirectory, "Contracts", $$"""
                using System;
                [assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
                namespace OrdinaryEquality;
                public sealed class {{nativeLeaf}} : {{nativeRoot}}, IEquatable<{{nativeLeaf}}> {
                    public int Extra { get; }
                    public Leaf(int extra) : base(0) => Extra = extra;
                    public bool Equals({{nativeLeaf}}? other) =>
                        other != null && GetType() == other.GetType() && Extra == other.Extra;
                    public override bool Equals(object? other) => other is {{nativeLeaf}} leaf && Equals(leaf);
                    public override int GetHashCode() => Extra;
                    public static bool operator ==({{nativeLeaf}}? left, {{nativeLeaf}}? right) =>
                        ReferenceEquals(left, right) || left is not null && left.Equals(right);
                    public static bool operator !=({{nativeLeaf}}? left, {{nativeLeaf}}? right) => !(left == right);
                }
                """, root);
            var consumer = CompileNative(fixture.Directory, "Consumer", $$"""
                using System;
                using System.Collections.Generic;
                using OrdinaryEquality;
                public static class Consumer {
                    public static string Run(string path) {
                        var first = new {{closedLeaf}}(7) { Tag = 41 };
                        var inherited = new {{closedLeaf}}(7) { Tag = 42 };
                        var derived = new {{closedLeaf}}(8) { Tag = 41 };
                        var same = new {{closedLeaf}}(7) { Tag = 41 };
                        {{closedRoot}} receiver = first;
                        Func<{{closedLeaf}}?, bool> selfGroup = first.Equals;
                        Func<object?, bool> objectGroup = first.Equals;
                        Func<{{closedRoot}}?, bool> baseGroup = receiver.Equals;
                        if (path != "base") {
                            {{closedRoot}}.Calls = 0;
                            foreach (var (other, equal) in new[] { (inherited, true), (derived, false), (same, true) })
                                foreach (var result in new[] {
                                    first.Equals(other), ((object)first).Equals(other),
                                    ((IEquatable<{{closedLeaf}}>)first).Equals(other),
                                    selfGroup(other), objectGroup(other),
                                    EqualityComparer<{{closedLeaf}}>.Default.Equals(first, other),
                                    first == other, !(first != other)
                                })
                                    if (result != equal) throw new Exception("ordinary self structural path");
                            if ({{closedRoot}}.Calls != 0) throw new Exception("ordinary self invoked domain equality");
                            if (first.Equals(({{closedLeaf}}?)null) || selfGroup(null) || objectGroup(null)
                                || first == null || null == first || !(first != null))
                                throw new Exception("ordinary self null control");
                        }
                        if (path != "self") {
                            {{closedRoot}}.Calls = 0;
                            foreach (var (other, equal) in new[] {
                                (inherited, false), (derived, true), (same, true), (({{closedLeaf}}?)null, false)
                            })
                                foreach (var result in new[] {
                                    receiver.Equals(other),
                                    ((IEquatable<{{closedRoot}}>)first).Equals(other),
                                    baseGroup(other),
                                    EqualityComparer<{{closedRoot}}>.Default.Equals(first, other)
                                })
                                    if (result != equal) throw new Exception("ordinary base domain path");
                            // EqualityComparer handles null without invoking the domain slot.
                            if ({{closedRoot}}.Calls != 15) throw new Exception("ordinary base domain call count:" + {{closedRoot}}.Calls);
                        }
                        {{closedLeaf}}? absent = null;
                        if (!(absent == null) || absent != null || first.Tag != 41 || first.Extra != 7)
                            throw new Exception("ordinary null/state control");
                        return "ordinary:" + path + ":structural/domain/null/state";
                    }
                }
                """, root, reference);
            foreach (var image in new[] { root, native, library })
            {
                IlVerifier.Verify(image, new[] { root });
            }

            IlVerifier.Verify(consumer, new[] { root, native });
            IlVerifier.Verify(consumer, new[] { root, library });
            var expected = "ordinary:" + path + ":structural/domain/null/state";
            Assert.Equal(expected, RunConsumer(root, native, consumer, path));
            Assert.Equal(expected, RunConsumer(root, library, consumer, path));
            this.output.WriteLine("SAME ordinary native consumer SHA256=" + Hash(consumer));
            var assemblies = EmittedFixture.LoadTogether(root, library);
            var leaf = assemblies[1].GetType("OrdinaryEquality.Leaf" + (generic ? "`1" : ""))
                ?? throw new InvalidOperationException("Missing ordinary leaf.");
            if (generic)
            {
                leaf = leaf.MakeGenericType(typeof(string));
            }

            var directBase = leaf.BaseType ?? throw new InvalidOperationException("Missing ordinary base.");
            var inheritedSlot = leaf.GetMethod("Equals", new[] { directBase })
                ?? throw new InvalidOperationException("Missing domain equality.");
            Assert.Equal(directBase, inheritedSlot.DeclaringType);
            Assert.Equal(final, inheritedSlot.IsFinal);
            Assert.Equal(directBase, leaf.GetInterfaceMap(typeof(IEquatable<>).MakeGenericType(directBase))
                .TargetMethods.Single().DeclaringType);
            var selfEquals = leaf.GetMethod("Equals", new[] { leaf })
                ?? throw new InvalidOperationException("Missing ordinary self equality.");
            Assert.True(selfEquals.IsFinal);
            Assert.DoesNotContain(IlInstructionReader.Read(selfEquals.GetMethodBody()?.GetILAsByteArray()
                ?? throw new InvalidOperationException("Missing ordinary equality body.")), instruction =>
                instruction.MetadataToken is int token
                && selfEquals.Module.ResolveMethod(token, leaf.GetGenericArguments(), null) is { } target
                && target.Name == "Equals" && target.DeclaringType == directBase);
            Assert.Equal(EqualityRows(library, expectedCount: 2), EqualityRows(reference, expectedCount: 2));
            using var references = ReferenceResolver.WithReferences(
                ReferenceResolver.HostTrustedPlatformAssemblyPaths().Append(root).ToArray());
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(
                references, GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(source)) { IsLibrary = true };
            Assert.Empty(compilation.GlobalScope.Diagnostics);
            var symbol = Assert.Single(compilation.GlobalScope.Structs, type => type.Name == "Leaf");
            var query = new MemberQuery(true, false, false, MemberKinds.Method);
            Assert.Null(symbol.DataEqualsBase);
            Assert.Equal(2, symbol.GetMethods("Equals").Length);
            Assert.Equal<FunctionSymbol>(symbol.GetMethods("Equals"), TypeMemberModel.GetMethods(symbol, "Equals", query));
        }
        finally
        {
            PreserveEvidence(fixture.Directory, $"ordinary-{generic}-{final}-{path}");
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedRecord_OptionalParameterNamePreservesSignatureAndDispatch(bool unnamed)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        using var fixture = new NativeSliceLanguageTests.Fixture();
        try
        {
            var root = CompileNative(fixture.Directory, "RootContracts", """
                namespace OptionalName;
                public record Root<T> {
                    public int Tag;
                    public Root(int tag) => Tag = tag;
                }
                """);
            if (unnamed)
            {
                ClearTypedEqualsParameterName(root);
            }

            var reference = Path.Combine(fixture.Directory, "Contracts.ref.dll");
            var library = fixture.Compile("""
                package OptionalName
                import System
                public data class Leaf[T any](Extra int32) : Root[T](0), IEquatable[Leaf[T]]
                """, "Contracts", executable: false,
                "/assemblyname:Contracts", "/r:" + root, "/refout:" + reference, "/debug:portable");
            var nativeDirectory = Path.Combine(fixture.Directory, "native");
            Directory.CreateDirectory(nativeDirectory);
            var native = CompileNative(nativeDirectory, "Contracts", """
                [assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
                namespace OptionalName;
                public sealed record Leaf<T>(int Extra) : Root<T>(0);
                """, root);
            var consumer = CompileNative(fixture.Directory, "Consumer", """
                using System;
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
                }
                """, root, reference);
            foreach (var image in new[] { root, native, library })
            {
                IlVerifier.Verify(image, new[] { root });
            }

            IlVerifier.Verify(consumer, new[] { root, native });
            IlVerifier.Verify(consumer, new[] { root, library });
            Assert.Equal("optional-name/equal/inherited/derived/null", RunConsumer(root, native, consumer, ""));
            Assert.Equal("optional-name/equal/inherited/derived/null", RunConsumer(root, library, consumer, ""));
            var assemblies = EmittedFixture.LoadTogether(root, library);
            var leaf = (assemblies[1].GetType("OptionalName.Leaf`1")
                ?? throw new InvalidOperationException("Missing optional-name leaf.")).MakeGenericType(typeof(string));
            var directBase = leaf.BaseType ?? throw new InvalidOperationException("Missing optional-name base.");
            var slot = leaf.GetMethod("Equals", new[] { directBase })
                ?? throw new InvalidOperationException("Missing optional-name override.");
            var parameter = Assert.Single(slot.GetParameters());
            Assert.Equal(unnamed ? "arg0" : "other", parameter.Name);
            Assert.Equal(NullabilityState.Nullable, new NullabilityInfoContext().Create(parameter).ReadState);
            Assert.Equal(directBase, slot.GetBaseDefinition().DeclaringType);
            Assert.Equal(EqualityRows(library), EqualityRows(reference));
        }
        finally
        {
            PreserveEvidence(fixture.Directory, unnamed ? "optional-unnamed" : "optional-named");
        }
    }

    private static void ClearTypedEqualsParameterName(string path)
    {
        var original = File.ReadAllBytes(path);
        var type = EmittedFixture.Load(original).GetType("OptionalName.Root`1")
            ?? throw new InvalidOperationException("Missing native root.");
        var slot = type.GetMethod("Equals", new[] { type })
            ?? throw new InvalidOperationException("Missing native typed slot.");
        using var pe = new PEReader(new MemoryStream(original));
        var metadata = pe.GetMetadataReader();
        var method = metadata.GetMethodDefinition(MetadataTokens.MethodDefinitionHandle(slot.MetadataToken & 0xFFFFFF));
        var parameterHandle = Assert.Single(method.GetParameters(),
            handle => metadata.GetParameter(handle).SequenceNumber == 1);
        var rowSize = metadata.GetTableRowSize(TableIndex.Param);
        var offset = pe.PEHeaders.MetadataStartOffset + metadata.GetTableMetadataOffset(TableIndex.Param)
            + ((MetadataTokens.GetRowNumber(parameterHandle) - 1) * rowSize) + 4;
        var mutated = (byte[])original.Clone();
        Array.Clear(mutated, offset, rowSize - 4);
        var differences = Enumerable.Range(0, original.Length).Where(i => original[i] != mutated[i]).ToArray();
        Assert.NotEmpty(differences);
        Assert.All(differences, index => Assert.InRange(index, offset, offset + rowSize - 5));
        File.WriteAllBytes(path + ".named-original", original);
        File.WriteAllText(path + ".name-mutation.json", JsonSerializer.Serialize(new
        {
            offset,
            stringIndexWidth = rowSize - 4,
            changedOffsets = differences,
            originalSha256 = Convert.ToHexString(SHA256.HashData(original)),
            mutatedSha256 = Convert.ToHexString(SHA256.HashData(mutated)),
            mvid = slot.Module.ModuleVersionId,
            token = slot.MetadataToken,
        }));
        File.WriteAllBytes(path, mutated);
    }

    [Theory]
    [InlineData(false, "inherited")]
    [InlineData(false, "derived")]
    [InlineData(false, "equal")]
    [InlineData(true, "inherited")]
    [InlineData(true, "derived")]
    [InlineData(true, "equal")]
    public void NativeConsumer_ImportedSymbolicBasePreservesBothFieldSets(bool reordered, string difference)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        using var fixture = new NativeSliceLanguageTests.Fixture();
        try
        {
            var root = CompileNative(fixture.Directory, "RootContracts", """
                namespace ImportedEquality;
                public record Root<T> {
                    public int Tag;
                    public T? Value;
                    public Root(int tag) => Tag = tag;
                }
                public record Reordered<A, B> : Root<B> {
                    public A? Owner;
                    public Reordered(int tag) : base(tag) { }
                }
                """);
            var declaration = reordered ? "Leaf[T any, U any]" : "Leaf[T any]";
            var baseType = reordered ? "Reordered[U, T]" : "Root[T]";
            var selfType = reordered ? "Leaf[T, U]" : "Leaf[T]";
            var closedLeaf = reordered ? "Leaf<string, int>" : "Leaf<string>";
            var closedBase = reordered ? "Reordered<int, string>" : "Root<string>";
            var nativeDeclaration = reordered ? "Leaf<T, U>" : "Leaf<T>";
            var nativeBase = reordered ? "Reordered<U, T>" : "Root<T>";
            var reference = Path.Combine(fixture.Directory, "Contracts.ref.dll");
            File.WriteAllText(Path.Combine(fixture.Directory, "gsc-invocation.json"), JsonSerializer.Serialize(new
            {
                entry = "GSharp.Compiler.Program.Main",
                compiler = typeof(Program).Assembly.Location,
                compilerSha256 = Hash(typeof(Program).Assembly.Location),
                core = typeof(TypeSymbol).Assembly.Location,
                coreSha256 = Hash(typeof(TypeSymbol).Assembly.Location),
                argv = new[]
                {
                    "/out:" + Path.Combine(fixture.Directory, "Contracts.dll"),
                    "/target:library", "/targetframework:net10.0",
                    Path.Combine(fixture.Directory, "Contracts.gs"),
                    "/assemblyname:Contracts", "/r:" + root, "/refout:" + reference, "/debug:portable",
                },
            }));
            var library = fixture.Compile($$"""
                package ImportedEquality
                import System
                public data class {{declaration}}(Extra int32) : {{baseType}}(0), IEquatable[{{selfType}}]
                """, "Contracts", executable: false,
                "/assemblyname:Contracts", "/r:" + root, "/refout:" + reference, "/debug:portable");
            var nativeDirectory = Path.Combine(fixture.Directory, "native");
            Directory.CreateDirectory(nativeDirectory);
            var native = CompileNative(nativeDirectory, "Contracts", $$"""
                [assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
                namespace ImportedEquality;
                public sealed record {{nativeDeclaration}}(int Extra) : {{nativeBase}}(0);
                """, root);
            var consumer = CompileNative(fixture.Directory, "Consumer", $$"""
                using System;
                using System.Collections.Generic;
                using ImportedEquality;
                public static class Consumer {
                    public static string Run(string difference) {
                        var first = new {{closedLeaf}}(7) { Tag = 41, Value = "base-value" };
                        var second = new {{closedLeaf}}(difference == "derived" ? 8 : 7) {
                            Tag = difference == "inherited" ? 42 : 41, Value = "base-value"
                        };
                        bool equal = difference == "equal";
                        Root<string> receiver = first;
                        {{closedBase}} direct = first;
                        Func<Root<string>?, bool> baseGroup = receiver.Equals;
                        Func<{{closedBase}}?, bool> directGroup = direct.Equals;
                        Func<{{closedLeaf}}?, bool> selfGroup = first.Equals;
                        Func<object?, bool> objectGroup = first.Equals;
                        bool[] comparisons = {
                            first.Equals(second), ((object)first).Equals(second),
                            receiver.Equals(second), ((IEquatable<Root<string>>)first).Equals(second),
                            ((IEquatable<{{closedLeaf}}>)first).Equals(second),
                            baseGroup(second), selfGroup(second), objectGroup(second),
                            EqualityComparer<Root<string>>.Default.Equals(first, second),
                            first == second, !(first != second),
                            direct.Equals(second), ((IEquatable<{{closedBase}}>)first).Equals(second),
                            directGroup(second)
                        };
                        for (int i = 0; i < comparisons.Length; i++)
                            if (comparisons[i] != equal) throw new Exception(difference + ":path" + i);
                        if (first.Equals(({{closedLeaf}}?)null) || receiver.Equals(null)
                            || baseGroup(null) || directGroup(null) || selfGroup(null) || objectGroup(null)
                            || first == null || null == first || !(first != null))
                            throw new Exception("null control");
                        {{closedLeaf}}? absent = null;
                        if (!(absent == null) || absent != null) throw new Exception("null operator control");
                        if (first.Tag != 41 || first.Extra != 7 || first.Value != "base-value")
                            throw new Exception("field control");
                        return difference + ":14-dispatch/null/field-controls";
                    }
                }
                """, root, reference);
            foreach (var image in new[] { root, native, library })
            {
                IlVerifier.Verify(image, new[] { root });
            }

            IlVerifier.Verify(consumer, new[] { root, native });
            IlVerifier.Verify(consumer, new[] { root, library });
            var expected = difference + ":14-dispatch/null/field-controls";
            Assert.Equal(expected, RunConsumer(root, native, consumer, difference));
            Assert.Equal(expected, RunConsumer(root, library, consumer, difference));
            this.output.WriteLine("SAME native consumer SHA256=" + Hash(consumer));
            this.output.WriteLine("gsc image SHA256=" + Hash(library));
            if (difference == "equal")
            {
                return;
            }

            var assemblies = EmittedFixture.LoadTogether(root, library);
            var leaf = assemblies[1].GetTypes().Single(type => type.Name.StartsWith("Leaf`", StringComparison.Ordinal));
            leaf = leaf.MakeGenericType(reordered ? new[] { typeof(string), typeof(int) } : new[] { typeof(string) });
            var directBase = leaf.BaseType ?? throw new InvalidOperationException("Missing direct base.");
            var slot = leaf.GetMethod("Equals", BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly,
                null, new[] { directBase }, null) ?? throw new InvalidOperationException("Missing imported typed-base override.");
            Assert.True(slot.IsVirtual && slot.IsFinal);
            Assert.Equal(0, (int)(slot.Attributes & MethodAttributes.NewSlot));
            Assert.Equal(directBase, slot.GetBaseDefinition().DeclaringType);
            var parameter = Assert.Single(slot.GetParameters());
            Assert.Equal("other", parameter.Name);
            Assert.Equal(NullabilityState.Nullable, new NullabilityInfoContext().Create(parameter).ReadState);
            if (reordered)
            {
                Assert.Equal(new[] { typeof(int), typeof(string) }, directBase.GetGenericArguments());
            }

            var selfEquals = leaf.GetMethod("Equals", new[] { leaf })
                ?? throw new InvalidOperationException("Missing self equality.");
            var instructions = IlInstructionReader.Read(selfEquals.GetMethodBody()?.GetILAsByteArray()
                ?? throw new InvalidOperationException("Missing self equality body."));
            var baseCall = Assert.Single(instructions, instruction =>
                instruction.MetadataToken is int token
                && selfEquals.Module.ResolveMethod(token, leaf.GetGenericArguments(), null) is { } target
                && target.Name == "Equals" && target.DeclaringType == directBase);
            Assert.Equal(OpCodes.Call, baseCall.OpCode);
            Assert.Equal(EqualityRows(library), EqualityRows(reference));
        }
        finally
        {
            PreserveEvidence(fixture.Directory, (reordered ? "reordered-" : "generic-") + difference);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SourceOnlyBase_OrdinaryAndGenericDispatchRemainStructural(bool generic)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        using var fixture = new NativeSliceLanguageTests.Fixture();
        try
        {
            var root = generic ? "Root[T any]" : "Root";
            var leaf = generic ? "Leaf[T any]" : "Leaf";
            var baseType = generic ? "Root[T]" : "Root";
            var closed = generic ? "Leaf[string]" : "Leaf";
            var library = fixture.Compile($$"""
                package SourceEquality
                import System
                public open data class {{root}}(Tag int32)
                public data class {{leaf}}(Tag int32, Extra int32) : {{baseType}}(Tag)
                public func Check() bool {
                    let first = {{closed}}(41, 7)
                    let same = {{closed}}(41, 7)
                    let inherited = {{closed}}(42, 7)
                    let derived = {{closed}}(41, 8)
                    let receiver {{(generic ? "Root[string]" : "Root")}} = first
                    let equals Func[{{(generic ? "Root[string]" : "Root")}}?, bool] = receiver.Equals
                    return first.Equals(same) && !first.Equals(inherited) && !first.Equals(derived)
                        && receiver.Equals(same) && !receiver.Equals(inherited) && !receiver.Equals(derived)
                        && equals(same) && !equals(inherited) && !equals(derived) && !equals(nil)
                        && first == same && first != inherited && first != derived
                }
                """, "SourceControls", executable: false);
            IlVerifier.Verify(library);
            var check = EmittedFixture.Load(library).GetTypes()
                .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static))
                .Single(method => method.Name == "Check");
            Assert.Equal(true, check.Invoke(null, null));
        }
        finally
        {
            PreserveEvidence(fixture.Directory, generic ? "source-generic" : "source-ordinary");
        }
    }

    private static string CompileNative(string directory, string name, string source, params string[] references)
    {
        var sourcePath = Path.Combine(directory, name + ".cs");
        var imagePath = Path.Combine(directory, name + ".dll");
        File.WriteAllText(sourcePath, source, Encoding.UTF8);
        var referencePaths = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Concat(references).ToArray();
        File.WriteAllText(sourcePath + ".inputs.json", JsonSerializer.Serialize(new
        {
            entry = "Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create/Emit",
            sourcePath,
            sourceSha256 = Hash(sourcePath),
            imagePath,
            pdbPath = Path.ChangeExtension(imagePath, ".pdb"),
            outputKind = "DynamicallyLinkedLibrary",
            nullableContext = "Enable",
            deterministic = true,
            debugInformationFormat = "PortablePdb",
            roslyn = typeof(CSharpCompilation).Assembly.Location,
            roslynSha256 = Hash(typeof(CSharpCompilation).Assembly.Location),
            references = referencePaths.Select(path => new { path, sha256 = Hash(path) }),
        }));
        var compilation = CSharpCompilation.Create(name,
            new[] { CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8, SourceHashAlgorithm.Sha256), path: sourcePath) },
            referencePaths.Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable, deterministic: true));
        using var image = File.Create(imagePath);
        using var pdb = File.Create(Path.ChangeExtension(imagePath, ".pdb"));
        var result = compilation.Emit(image, pdb,
            options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        Assert.True(pdb.Length > 0);
        return imagePath;
    }

    private static object RunConsumer(string root, string library, string consumer, string difference)
    {
        var assemblies = EmittedFixture.LoadTogether(root, library, consumer);
        return (assemblies[2].GetType("Consumer")?.GetMethod("Run")
            ?? throw new InvalidOperationException("Missing native consumer.")).Invoke(null, new object[] { difference });
    }

    private static string[] EqualityRows(string path, int expectedCount = 3)
    {
        using var stream = File.OpenRead(path);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var rows = metadata.TypeDefinitions.SelectMany(handle => metadata.GetTypeDefinition(handle).GetMethods())
            .Select(handle => metadata.GetMethodDefinition(handle))
            .Where(method => metadata.GetString(method.Name) == "Equals")
            .Select(method => method.Attributes + "|" + Convert.ToHexString(metadata.GetBlobBytes(method.Signature))
                + "|" + string.Join(";", method.GetParameters().Select(handle =>
                {
                    var parameter = metadata.GetParameter(handle);
                    return metadata.GetString(parameter.Name) + ":"
                        + string.Join(",", parameter.GetCustomAttributes().Select(attribute =>
                            Convert.ToHexString(metadata.GetBlobBytes(metadata.GetCustomAttribute(attribute).Value))));
                }))).ToArray();
        Assert.Equal(expectedCount, rows.Length);
        var implementations = metadata.TypeDefinitions
            .SelectMany(handle => metadata.GetTypeDefinition(handle).GetMethodImplementations())
            .Select(handle => metadata.GetMethodImplementation(handle))
            .Where(implementation => implementation.MethodDeclaration.Kind == HandleKind.MemberReference)
            .Select(implementation => metadata.GetMemberReference((MemberReferenceHandle)implementation.MethodDeclaration))
            .Where(member => metadata.GetString(member.Name) == "Equals").ToArray();
        if (expectedCount == 2)
        {
            Assert.Empty(implementations);
        }
        else
        {
            Assert.NotEmpty(implementations);
            Assert.Contains(implementations, member => member.Parent.Kind == HandleKind.TypeSpecification);
        }
        return rows;
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    private static void PreserveEvidence(string directory, string name)
    {
        var root = Environment.GetEnvironmentVariable("GSHARP_4778_EVIDENCE_ROOT");
        if (string.IsNullOrEmpty(root))
        {
            return;
        }

        var destination = Path.Combine(root, name);
        foreach (var path in Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(directory, path));
            Directory.CreateDirectory(Path.GetDirectoryName(target) ?? throw new InvalidOperationException("Missing evidence directory."));
            File.Copy(path, target, overwrite: true);
        }
    }
}
