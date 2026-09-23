// <copyright file="Issue4350IndexRangeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0187 / issue #4350: cs2gs preserves C# <c>System.Index</c> /
/// <c>System.Range</c> declarations and expressions as first-class G# syntax,
/// translates C# <c>~</c> to G# <c>~</c>, and keeps compiler-recognized
/// runtime types nominal inside the compilation that declares them.
/// </summary>
public class Issue4350IndexRangeTranslationTests
{
    [Fact]
    public void IndexAndRangeDeclarations_PreserveReadableSyntax_AndRunLikeCSharp()
    {
        const string source = @"
using System;
using System.Collections.Generic;
namespace Corpus.Issue4350
{
    public class Probe
    {
        private Index field = ^2;

        private static Range Trim() => ^4..^1;

        private static int Pick(int[] values, Index index) => values[index];

        public static string Run()
        {
            int[] values = { 10, 20, 30, 40, 50 };
            Index i = ^2;
            Range r = ^4..^1;
            Range tail = ^3..;
            Range head = ..^2;
            Range all = ..;
            var ids = new List<Index> { ^1, ^5 };
            Index? maybe = ^3;
            int mask = 6;
            var probe = new Probe();
            int[] trimmed = values[Trim()];
            return string.Join("","", values[i], values[r].Length, values[tail][0], values[head].Length,
                values[all].Length, Pick(values, ids[1]), values[maybe.Value], ~mask, mask ^ 3,
                values[probe.field], trimmed[0], values[i..]);
        }
    }
}
";
        string printed = Render(source);

        Assert.Contains("= ^2", printed, StringComparison.Ordinal);
        Assert.Contains("^4..^1", printed, StringComparison.Ordinal);
        Assert.Contains("^3..", printed, StringComparison.Ordinal);
        Assert.Contains("..^2", printed, StringComparison.Ordinal);
        Assert.Contains("~mask", printed, StringComparison.Ordinal);
        Assert.Contains("mask ^ 3", printed, StringComparison.Ordinal);
        Assert.Contains("values[i]", printed, StringComparison.Ordinal);
        Assert.Contains("values[r]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("FromEnd(", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Range(", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);

        var result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("40,3,30,3,5,10,30,-7,5,40,20,System.Int32[]", result.Value);
    }

    [Fact]
    public void BitwiseNot_TranslatesToTilde_EverywhereIncludingBrackets()
    {
        string printed = Render(@"
namespace Corpus.Issue4350
{
    public enum Flags { None = 0, All = ~0 }

    public class Probe
    {
        public static int Run(int[] values, int index, uint bits, Flags flags)
            => values[~index] + (int)~bits + (int)~flags;
    }
}
");

        Assert.Contains("values[~index]", printed, StringComparison.Ordinal);
        Assert.Contains("~bits", printed, StringComparison.Ordinal);
        Assert.Contains("~flags", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(^", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);
    }

    [Fact]
    public void UserDefinedOnesComplementOperator_TranslatesToTildeOperator()
    {
        string printed = Render(@"
namespace Corpus.Issue4350
{
    public readonly struct Bits
    {
        public Bits(int value) => Value = value;

        public int Value { get; }

        public static Bits operator ~(Bits value) => new Bits(~value.Value);
    }

    public class Probe
    {
        public static int Run() => (~new Bits(6)).Value;
    }
}
");

        Assert.Contains("operator ~()", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);
        var result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-7, result.Value);
    }

    [Fact]
    public void RecognizedRuntimeTypes_StayNominalInsideTheirDeclaringCompilation()
    {
        const string runtime = @"
using System;
using System.Collections;
using System.Collections.Generic;
namespace Gsharp.Values
{
    public readonly struct Slice<T> : IEquatable<Slice<T>>, IEnumerable<T>
    {
        private readonly T[] owner;

        private Slice(T[] owner) => this.owner = owner;

        public int Length => owner.Length;

        public ref T this[Index index] => ref owner[index.GetOffset(Length)];

        public static Slice<T> FromArray(T[] array) => new Slice<T>(array);

        public Slice<T> Subslice(Range range) => new Slice<T>(owner[range]);

        public ReadOnlySlice<T> AsReadOnly() => new ReadOnlySlice<T>(this);

        public static bool operator ==(Slice<T> left, Slice<T> right) => left.Equals(right);

        public static bool operator !=(Slice<T> left, Slice<T> right) => !left.Equals(right);

        public bool Equals(Slice<T> other) => ReferenceEquals(owner, other.owner);

        public override bool Equals(object obj) => obj is Slice<T> other && Equals(other);

        public override int GetHashCode() => owner.GetHashCode();

        public Enumerator GetEnumerator() => new Enumerator(this);

        IEnumerator<T> IEnumerable<T>.GetEnumerator() => GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        public struct Enumerator : IEnumerator<T>
        {
            private readonly Slice<T> slice;
            private int index;

            internal Enumerator(Slice<T> slice)
            {
                this.slice = slice;
                index = -1;
            }

            public T Current => slice.owner[index];

            object IEnumerator.Current => Current;

            public bool MoveNext() => ++index < slice.Length;

            public void Reset() => index = -1;

            public void Dispose()
            {
            }
        }
    }

    public readonly struct ReadOnlySlice<T>
    {
        private readonly Slice<T> slice;

        internal ReadOnlySlice(Slice<T> slice) => this.slice = slice;

        public int Length => slice.Length;

        public static implicit operator ReadOnlySlice<T>(Slice<T> value) => value.AsReadOnly();
    }

    public abstract class ManagedRef<T>
    {
        public abstract ref T Borrow();

        public static bool operator ==(ManagedRef<T> left, ManagedRef<T> right) => ReferenceEquals(left, right);

        public static bool operator !=(ManagedRef<T> left, ManagedRef<T> right) => !(left == right);

        public override bool Equals(object obj) => ReferenceEquals(this, obj);

        public override int GetHashCode() => 0;
    }
}
";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Runtime.cs", runtime) },
            assemblyName: "Gsharp.Runtime.Values");
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.DoesNotContain("slice[", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("managed ", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("TypeReference", printed, StringComparison.Ordinal);
        Assert.Contains("Slice[T]", printed, StringComparison.Ordinal);
        Assert.Contains("IEquatable[Slice[T]]", printed, StringComparison.Ordinal);
        Assert.Contains("ManagedRef[T]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RecognizedRuntimeTypes_KeepNativeConsumerViewFromMetadata()
    {
        const string source = @"
using Gsharp.Values;
namespace Corpus.Issue4350
{
    public class Consumer
    {
        public Slice<int> Mutable;
        public ReadOnlySlice<string> View;
    }
}
";
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice<>).Assembly.Location),
        };
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Consumer.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("slice[int32]", printed, StringComparison.Ordinal);
        Assert.Contains("readonly slice[string]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void StructObjectOverrides_StayVirtualOverrides()
    {
        string printed = Render(@"
using System;
using System.Collections.Generic;
namespace Corpus.Issue4350
{
    public readonly struct Key : IEquatable<Key>
    {
        public Key(int id) => Id = id;

        public int Id { get; }

        public bool Equals(Key other) => Id % 10 == other.Id % 10;

        public override bool Equals(object obj) => obj is Key other && Equals(other);

        public override int GetHashCode() => Id % 10;

        public override string ToString() => ""key"" + Id;
    }

    public class Probe
    {
        public static string Run()
        {
            object a = new Key(1);
            object b = new Key(11);
            var set = new HashSet<object> { a };
            return a.Equals(b) + "","" + set.Contains(b) + "","" + a;
        }
    }
}
");

        // Issue #4350: dropping `override` on a struct declared a new,
        // non-virtual `Equals(object)` that hid the override, so boxed
        // equality silently fell back to ValueType.Equals.
        Assert.Contains("override func Equals(obj object) bool", printed, StringComparison.Ordinal);
        Assert.Contains("override func GetHashCode() int32", printed, StringComparison.Ordinal);
        Assert.Contains("override func ToString() string", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);

        var result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("True,True,key1", result.Value);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity is TranslationSeverity.Unsupported or TranslationSeverity.Warning);
        return printed;
    }
}
