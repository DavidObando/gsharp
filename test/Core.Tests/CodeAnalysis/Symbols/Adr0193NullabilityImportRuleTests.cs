// <copyright file="Adr0193NullabilityImportRuleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0193 Phase 1: <see cref="NullabilityImportRule"/>'s decision tables,
/// its gsc appliers, the walkers routed through it, the
/// <see cref="PlatformTypeSymbol.Get"/> smart-constructor invariant, and the
/// two query members <see cref="TypeSymbol.ReferenceNullability"/> and
/// <see cref="TypeSymbol.GetElementPositions"/>.
/// </summary>
public sealed class Adr0193NullabilityImportRuleTests
{
    /// <summary>
    /// ADR-0193 §1's <c>DecideOpenSlot</c> table, every cell. Only an explicit
    /// <c>[Nullable(2)]</c> over a known reference argument widens; the
    /// <c>Annotated</c> × <c>Unknown</c> cell is <c>Unchanged</c> by the
    /// owner's ruling on Open question 1 (revisit: #4385).
    /// </summary>
    /// <param name="state">The declared state at the slot.</param>
    /// <param name="kind">The argument's kind.</param>
    /// <param name="expected">The decision.</param>
    [Theory]
    [InlineData("Annotated", "Reference", "Nullable")]
    [InlineData("Annotated", "Value", "Unchanged")]
    [InlineData("Annotated", "Unknown", "Unchanged")]
    [InlineData("NotAnnotated", "Reference", "Unchanged")]
    [InlineData("NotAnnotated", "Value", "Unchanged")]
    [InlineData("NotAnnotated", "Unknown", "Unchanged")]
    [InlineData("Oblivious", "Reference", "Unchanged")]
    [InlineData("Oblivious", "Value", "Unchanged")]
    [InlineData("Oblivious", "Unknown", "Unchanged")]
    public void DecideOpenSlot_Is_The_Adr_Table(string state, string kind, string expected)
        => Assert.Equal(
            Enum.Parse<ImportedReferenceNullability>(expected),
            NullabilityImportRule.DecideOpenSlot(Enum.Parse<ClrNullabilityState>(state), Enum.Parse<TypeArgumentKind>(kind)));

    /// <summary>ADR-0186 §2's concrete table: a value position is never wrapped.</summary>
    /// <param name="state">The declared state.</param>
    /// <param name="kind">The position's kind.</param>
    /// <param name="expected">The decision.</param>
    [Theory]
    [InlineData("NotAnnotated", "Reference", "NotNull")]
    [InlineData("Annotated", "Reference", "Nullable")]
    [InlineData("Oblivious", "Reference", "Platform")]
    [InlineData("NotAnnotated", "Value", "Unchanged")]
    [InlineData("Annotated", "Value", "Unchanged")]
    [InlineData("Oblivious", "Value", "Unchanged")]
    [InlineData("Annotated", "Unknown", "Nullable")]
    public void DecideConcrete_Is_The_Adr_Table(string state, string kind, string expected)
        => Assert.Equal(
            Enum.Parse<ImportedReferenceNullability>(expected),
            NullabilityImportRule.DecideConcrete(Enum.Parse<ClrNullabilityState>(state), Enum.Parse<TypeArgumentKind>(kind)));

    /// <summary>
    /// ADR-0193 §1: <c>Unchanged</c> preserves the input exactly. A
    /// <c>string?</c> argument substituted into an <c>Annotated</c>,
    /// <c>NotAnnotated</c> or <c>Oblivious</c> open slot is <c>string?</c> in
    /// all three.
    /// </summary>
    /// <param name="state">The declared state at the slot.</param>
    [Theory]
    [InlineData("Annotated")]
    [InlineData("NotAnnotated")]
    [InlineData("Oblivious")]
    public void ApplyOpenSlot_Keeps_A_Nullable_Argument_Nullable(string state)
    {
        var argument = NullableTypeSymbol.Get(TypeSymbol.String);
        Assert.Same(argument, NullabilityImportRule.ApplyOpenSlot(argument, Enum.Parse<ClrNullabilityState>(state)));
    }

    /// <summary>
    /// ADR-0193 owner decision 1, at the gsc applier: an annotated open slot
    /// widens a reference argument only. <c>Min&lt;int&gt;()</c> returns
    /// <c>int</c>; an unconstrained <c>T</c> stays <c>T</c>; a
    /// reference-constrained <c>T</c> becomes <c>T?</c>; a platform argument's
    /// unstated nullability yields to the declarer's explicit <c>?</c>.
    /// </summary>
    [Fact]
    public void ApplyOpenSlot_Annotated_Widens_Only_A_Reference_Argument()
    {
        const ClrNullabilityState Annotated = ClrNullabilityState.Annotated;
        Assert.Same(NullableTypeSymbol.Get(TypeSymbol.String), NullabilityImportRule.ApplyOpenSlot(TypeSymbol.String, Annotated));
        Assert.Same(TypeSymbol.Int32, NullabilityImportRule.ApplyOpenSlot(TypeSymbol.Int32, Annotated));

        var tuple = TupleTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.String, TypeSymbol.Int32));
        Assert.Same(tuple, NullabilityImportRule.ApplyOpenSlot(tuple, Annotated));

        var unconstrained = TypeParameter();
        Assert.Same(unconstrained, NullabilityImportRule.ApplyOpenSlot(unconstrained, Annotated));

        var classConstrained = TypeParameter();
        classConstrained.HasReferenceTypeConstraint = true;
        Assert.Same(NullableTypeSymbol.Get(classConstrained), NullabilityImportRule.ApplyOpenSlot(classConstrained, Annotated));

        var structConstrained = TypeParameter();
        structConstrained.HasValueTypeConstraint = true;
        Assert.Same(structConstrained, NullabilityImportRule.ApplyOpenSlot(structConstrained, Annotated));

        Assert.Same(
            NullableTypeSymbol.Get(TypeSymbol.String),
            NullabilityImportRule.ApplyOpenSlot(PlatformTypeSymbol.Get(TypeSymbol.String), Annotated));
    }

    /// <summary>
    /// ADR-0193 §2: <see cref="PlatformTypeSymbol.Get"/> normalises in the
    /// mirror direction of <see cref="NullableTypeSymbol.Get"/>, so neither
    /// <c>T?!</c> nor <c>T!?</c> is constructible, and a value type has no
    /// platform reading.
    /// </summary>
    [Fact]
    public void PlatformTypeSymbol_Get_Is_A_Normalising_Smart_Constructor()
    {
        var nullable = NullableTypeSymbol.Get(TypeSymbol.String);
        Assert.Same(nullable, PlatformTypeSymbol.Get(nullable));

        var platform = Assert.IsType<PlatformTypeSymbol>(PlatformTypeSymbol.Get(TypeSymbol.String));
        Assert.Same(platform, PlatformTypeSymbol.Get(platform));
        Assert.Same(nullable, NullableTypeSymbol.Get(platform));

        Assert.Same(TypeSymbol.Int32, PlatformTypeSymbol.Get(TypeSymbol.Int32));
        var valueNullable = NullableTypeSymbol.Get(TypeSymbol.Int32);
        Assert.Same(valueNullable, PlatformTypeSymbol.Get(valueNullable));
        var tuple = TupleTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.String, TypeSymbol.String));
        Assert.Same(tuple, PlatformTypeSymbol.Get(tuple));

        var structConstrained = TypeParameter();
        structConstrained.HasValueTypeConstraint = true;
        Assert.Same(structConstrained, PlatformTypeSymbol.Get(structConstrained));

        // An unconstrained type parameter is not known to be a value type, so
        // ADR-0186 §9's oblivious wrapping of one is still expressible.
        var unconstrained = TypeParameter();
        Assert.IsType<PlatformTypeSymbol>(PlatformTypeSymbol.Get(unconstrained));

        // The invariant, stated over every shape above: a PlatformTypeSymbol
        // never wraps a NullableTypeSymbol, another PlatformTypeSymbol, or a
        // value type.
        foreach (var underlying in new TypeSymbol[] { TypeSymbol.String, nullable, platform, TypeSymbol.Int32, valueNullable, tuple, structConstrained, unconstrained })
        {
            if (PlatformTypeSymbol.Get(underlying) is PlatformTypeSymbol wrapped)
            {
                Assert.IsNotType<NullableTypeSymbol>(wrapped.UnderlyingType);
                Assert.IsNotType<PlatformTypeSymbol>(wrapped.UnderlyingType);
                Assert.NotEqual(TypeArgumentKind.Value, NullabilityImportRule.ClassifyArgument(wrapped.UnderlyingType));
            }
        }
    }

    /// <summary>ADR-0193 §2: <see cref="TypeSymbol.ReferenceNullability"/>'s four answers.</summary>
    [Fact]
    public void ReferenceNullability_Reads_Through_The_Wrappers()
    {
        Assert.Equal(ReferenceNullabilityKind.NotNull, TypeSymbol.String.ReferenceNullability);
        Assert.Equal(ReferenceNullabilityKind.Nullable, NullableTypeSymbol.Get(TypeSymbol.String).ReferenceNullability);
        Assert.Equal(ReferenceNullabilityKind.Platform, PlatformTypeSymbol.Get(TypeSymbol.String).ReferenceNullability);
        Assert.Equal(ReferenceNullabilityKind.NotApplicable, TypeSymbol.Int32.ReferenceNullability);
        Assert.Equal(ReferenceNullabilityKind.NotApplicable, NullableTypeSymbol.Get(TypeSymbol.Int32).ReferenceNullability);
        Assert.Equal(ReferenceNullabilityKind.Nullable, TypeSymbol.Null.ReferenceNullability);
        Assert.Equal(ReferenceNullabilityKind.NotNull, TypeParameter().ReferenceNullability);

        var annotated = new NullabilityAnnotatedTypeSymbol(
            SliceTypeSymbol.Get(TypeSymbol.String),
            ImmutableArray.Create((byte)1, (byte)2));
        Assert.Equal(ReferenceNullabilityKind.NotNull, annotated.ReferenceNullability);
        Assert.Equal(ReferenceNullabilityKind.Nullable, NullableTypeSymbol.Get(annotated).ReferenceNullability);
    }

    /// <summary>
    /// ADR-0193 §2: <see cref="TypeSymbol.GetElementPositions"/> reads both
    /// Layer 3 representations the same way — nested wrappers, and a lazily
    /// decoded <see cref="NullabilityAnnotatedTypeSymbol"/>.
    /// </summary>
    [Fact]
    public void GetElementPositions_Agrees_Across_Both_Layer3_Representations()
    {
        using var resolver = ReferenceResolver.Default();
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var listDefinition));
        var listOfString = listDefinition.MakeGenericType(typeof(string));

        // Nested wrapper: `List[string?]` as the symbolic model builds it.
        var nested = ImportedTypeSymbol.GetConstructed(
            listOfString,
            listDefinition,
            ImmutableArray.Create<TypeSymbol>(NullableTypeSymbol.Get(TypeSymbol.String)));

        // Lazy flags: the same type as `ClrNullability` decodes `[Nullable({1, 2})]`.
        var lazy = ClrNullability.SymbolFromFlagsOffset(listOfString, ImmutableArray.Create((byte)1, (byte)2), 0);

        Assert.Equal(
            ReferenceNullabilityKind.Nullable,
            Assert.Single(nested.GetElementPositions()).ReferenceNullability);
        Assert.Equal(
            ReferenceNullabilityKind.Nullable,
            Assert.Single(lazy.GetElementPositions()).ReferenceNullability);

        Assert.Equal(
            new[] { ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Platform },
            MapTypeSymbol.Get(TypeSymbol.String, PlatformTypeSymbol.Get(TypeSymbol.Object))
                .GetElementPositions()
                .Select(p => p.ReferenceNullability));
    }

    /// <summary>
    /// A constructed same-compilation type carries its arguments symbolically,
    /// with no CLR type before emit; its positions are those arguments.
    /// </summary>
    [Fact]
    public void GetElementPositions_Reads_A_Constructed_Source_Types_Arguments()
    {
        const string source = """
            package adr0193positions

            class Box[T] {
                var Value T
            }

            func Take(b Box[string?]) {
            }
            """;
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(
            GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(source)))
        {
            IsLibrary = true,
            Nullability = NullabilityMode.PlatformTypes,
        };

        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, d => d.IsError);
        var take = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == "Take");
        var box = Assert.Single(take.Parameters).Type;
        Assert.Equal(ReferenceNullabilityKind.NotNull, box.ReferenceNullability);
        Assert.Equal(
            ReferenceNullabilityKind.Nullable,
            Assert.Single(box.GetElementPositions()).ReferenceNullability);
    }

    /// <summary>
    /// ADR-0193 §1, the projection reader's open-slot arm: an explicit
    /// <c>[Nullable(2)]</c> annotates the substituted argument's ROOT only.
    /// It used to expand <c>2</c> over every position of the argument, so
    /// <c>[Nullable(2)] TSource</c> at <c>TSource := List&lt;string&gt;</c>
    /// read <c>List&lt;string?&gt;?</c> through the projection and
    /// <c>List&lt;string&gt;?</c> through the merge.
    /// </summary>
    [Fact]
    public void ApplyOpenSlotToFlags_Annotates_Only_The_Arguments_Root()
    {
        using var resolver = ReferenceResolver.Default();
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var listDefinition));
        Assert.True(resolver.TryResolveType("System.Collections.Generic.KeyValuePair`2", out var pairDefinition));
        var listOfString = listDefinition.MakeGenericType(typeof(string));
        var pair = pairDefinition.MakeGenericType(typeof(string), typeof(string));

        Assert.Equal(new byte[] { 2, 1 }, NullabilityImportRule.ApplyOpenSlotToFlags(listOfString, ClrNullabilityState.Annotated));
        Assert.Equal(new byte[] { 1, 1 }, NullabilityImportRule.ApplyOpenSlotToFlags(listOfString, ClrNullabilityState.Oblivious));

        // A value-type argument takes no `?`, and neither do its inner positions.
        Assert.Equal(new byte[] { 0, 1, 1 }, NullabilityImportRule.ApplyOpenSlotToFlags(pair, ClrNullabilityState.Annotated));
        Assert.Empty(NullabilityImportRule.ApplyOpenSlotToFlags(typeof(int), ClrNullabilityState.Annotated));
    }

    /// <summary>
    /// The projection regression end to end, through the real reader and the
    /// real <c>Enumerable.FirstOrDefault&lt;TSource&gt;</c> declaration.
    /// </summary>
    [Fact]
    public void FirstOrDefault_Over_A_List_Reads_The_Same_Through_Projection_And_Merge()
    {
        using var scope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes);
        using var resolver = ReferenceResolver.Default();
        Assert.True(resolver.TryResolveType("System.Linq.Enumerable", out var enumerable));
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var listDefinition));
        var listOfString = listDefinition.MakeGenericType(typeof(string));
        var open = enumerable.GetMethods()
            .Single(m => m.Name == "FirstOrDefault" && m.GetParameters().Length == 1);
        var closed = open.MakeGenericMethod(listOfString);

        var projected = ClrNullability.GetReturnTypeSymbol(closed);
        var merged = NullableFlagsBuilder.MergeDeclarationNullability(
            TypeSymbol.FromClrType(listOfString),
            open.ReturnType,
            ClrNullability.ReadNullableFlags(open.ReturnParameter, open));

        foreach (var read in new[] { projected, merged })
        {
            Assert.Equal(ReferenceNullabilityKind.Nullable, read.ReferenceNullability);
            Assert.Equal(ReferenceNullabilityKind.NotNull, Assert.Single(read.GetElementPositions()).ReferenceNullability);
        }
    }

    /// <summary>
    /// ADR-0193 Open question 1, at the merge reader: an explicit
    /// <c>[Nullable(2)]</c> open slot over an unconstrained G# type parameter
    /// leaves it alone. On <c>main</c> before Phase 1 the merge widened it to
    /// <c>T?</c> (the round-2 guard from PR #4362 was reverted with round 3);
    /// the owner's ruling is <c>Unchanged</c>. A reference-constrained
    /// parameter still widens.
    /// </summary>
    [Fact]
    public void Merge_Leaves_An_Unconstrained_Type_Parameter_Alone_At_An_Annotated_Slot()
    {
        using var scope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes);
        using var resolver = ReferenceResolver.Default();
        Assert.True(resolver.TryResolveType("System.Linq.Enumerable", out var enumerable));
        var open = enumerable.GetMethods()
            .Single(m => m.Name == "FirstOrDefault" && m.GetParameters().Length == 1);
        var flags = ClrNullability.ReadNullableFlags(open.ReturnParameter, open);
        Assert.Equal(ClrNullabilityState.Annotated, ClrNullability.ClassifyPosition(flags, 0));

        var unconstrained = TypeParameter();
        Assert.Same(unconstrained, NullableFlagsBuilder.MergeDeclarationNullability(unconstrained, open.ReturnType, flags));

        var classConstrained = TypeParameter();
        classConstrained.HasReferenceTypeConstraint = true;
        Assert.Same(
            NullableTypeSymbol.Get(classConstrained),
            NullableFlagsBuilder.MergeDeclarationNullability(classConstrained, open.ReturnType, flags));

        // `--nullability=enabled` (retired by #4372) keeps its own arm.
        using (NullabilityOptions.Enter(NullabilityMode.Enabled))
        {
            Assert.Same(
                NullableTypeSymbol.Get(unconstrained),
                NullableFlagsBuilder.MergeDeclarationNullability(unconstrained, open.ReturnType, flags));
        }
    }

    /// <summary>
    /// ADR-0193 §4 found the field and property readers reading an open
    /// declaration's bytes against the CLOSED type, so an oblivious open slot
    /// stamped <c>T!</c> onto the argument — issue #4361's defect, on the one
    /// path its fix did not reach. <c>Tuple&lt;T1&gt;.Item1</c> in
    /// netstandard2.0 carries no nullable metadata at all; closed over
    /// <c>string</c> it reads <c>string</c>, like every sibling reader.
    /// </summary>
    [Fact]
    public void An_Oblivious_Open_Slot_Property_Reads_Its_Argument()
    {
        using var scope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes);
        var refDirectory = typeof(Adr0193NullabilityImportRuleTests).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "NetStandard20ReferenceDirectory")
            .Value ?? throw new Xunit.Sdk.XunitException("prerequisite missing: NetStandard20ReferenceDirectory");
        Assert.True(Directory.Exists(refDirectory), $"prerequisite missing: '{refDirectory}'");
        using var resolver = ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory, "*.dll"));
        Assert.True(resolver.TryResolveType("System.Tuple`1", out var tupleDefinition));
        Assert.True(resolver.TryResolveType("System.String", out var stringType));
        var item1 = tupleDefinition.MakeGenericType(stringType).GetProperty("Item1")
            ?? throw new Xunit.Sdk.XunitException("Tuple<T1>.Item1 not found");

        Assert.Same(TypeSymbol.String, ClrNullability.GetPropertyTypeSymbol(item1));

        // …while a concrete oblivious position is still `T!`.
        var toString = tupleDefinition.MakeGenericType(stringType).GetMethod("ToString", Type.EmptyTypes)
            ?? throw new Xunit.Sdk.XunitException("Tuple<T1>.ToString not found");
        Assert.Equal(ReferenceNullabilityKind.Platform, ClrNullability.GetReturnTypeSymbol(toString).ReferenceNullability);
    }

    /// <summary>
    /// The Open question 1 cell at the program level, where users see it:
    /// <c>List&lt;T&gt;.Find</c> returns <c>[Nullable(2)] T</c>, and inside a
    /// generic G# function over an unconstrained <c>T</c> the call binds as
    /// <c>T</c> — the same answer <c>values.Min()</c> gives
    /// (<c>Issue2494EnumLinqExtremaTests</c>). Before ADR-0193 Phase 1 the
    /// receiver merge widened it to <c>T?</c>, and this function reported a
    /// <c>T?</c>-to-<c>T</c> conversion error.
    /// </summary>
    [Fact]
    public void Find_On_A_List_Of_An_Unconstrained_Type_Parameter_Binds_As_T()
    {
        const string source = """
            package adr0193find
            import System
            import System.Collections.Generic

            func FindIn[T](xs List[T], match Predicate[T]) T -> xs.Find(match)
            """;
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(
            GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(source)))
        {
            IsLibrary = true,
            Nullability = NullabilityMode.PlatformTypes,
        };

        Assert.DoesNotContain(compilation.GlobalScope.Diagnostics, d => d.IsError);
        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, d => d.IsError);
        var function = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == "FindIn");
        var finder = new FindCallFinder();
        finder.Visit(compilation.BoundProgram.Functions[function]);
        Assert.IsType<TypeParameterSymbol>(Assert.Single(finder.Types));
    }

    /// <summary>
    /// A slot is "unsubstituted" only when the argument is the slot's OWN
    /// generic parameter. For a type-level parameter that means the same owner,
    /// not merely the same name and ordinal: <c>Collection&lt;T&gt;</c>'s
    /// <c>T</c> seen through <c>ObservableCollection&lt;T&gt;</c> is a
    /// substitution by a different parameter. A method's parameter is the same
    /// slot whether it is reached through the open or a closed declaring type.
    /// </summary>
    [Fact]
    public void IsUnsubstitutedSlot_Compares_The_Owner_Not_The_Name()
    {
        var baseT = typeof(System.Collections.ObjectModel.Collection<>).GetGenericArguments()[0];
        var derivedT = typeof(System.Collections.ObjectModel.ObservableCollection<>).GetGenericArguments()[0];
        Assert.Equal(baseT.Name, derivedT.Name);
        Assert.True(NullabilityImportRule.IsUnsubstitutedSlot(baseT, baseT));
        Assert.False(NullabilityImportRule.IsUnsubstitutedSlot(derivedT, baseT));

        var openConvertAll = typeof(System.Collections.Generic.List<>).GetMethod("ConvertAll")
            ?? throw new Xunit.Sdk.XunitException("List<T>.ConvertAll not found");
        var closedConvertAll = typeof(System.Collections.Generic.List<string>).GetMethod("ConvertAll")
            ?? throw new Xunit.Sdk.XunitException("List<string>.ConvertAll not found");
        Assert.True(NullabilityImportRule.IsUnsubstitutedSlot(
            closedConvertAll.GetGenericArguments()[0],
            openConvertAll.GetGenericArguments()[0]));
        var select = typeof(Enumerable).GetMethods().First(m => m.Name == "Select");
        Assert.False(NullabilityImportRule.IsUnsubstitutedSlot(
            select.GetGenericArguments()[0],
            openConvertAll.GetGenericArguments()[0]));
    }

    /// <summary>
    /// The CLR classifier follows a dependent bound transitively, as the
    /// <see cref="TypeSymbol"/> classifier does through
    /// <see cref="TypeParameterSymbol.DependentBoundProvesReferenceType"/>:
    /// in <c>where U : class where T : U</c>, <c>T</c> is a reference, and a
    /// cyclic or interface-only chain is <c>Unknown</c>.
    /// </summary>
    [Fact]
    public void ClassifyArgument_Follows_A_Clr_Dependent_Bound()
    {
        var compilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create(
            "Adr0193DependentBounds",
            new[]
            {
                Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText("""
                    public class Chain<U, T> where U : class where T : U { }
                    public class Longer<A, B, C> where A : class where B : A where C : B { }
                    public class Open<U, T> where T : U { }
                    """),
            },
            new[] { Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions(Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary));
        using var stream = new MemoryStream();
        var emit = compilation.Emit(stream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        var assembly = Assembly.Load(stream.ToArray());

        Type Parameter(string type, int index)
            => (assembly.GetType(type) ?? throw new Xunit.Sdk.XunitException(type + " not emitted")).GetGenericArguments()[index];

        Assert.Equal(TypeArgumentKind.Reference, NullabilityImportRule.ClassifyArgument(Parameter("Chain`2", 1)));
        Assert.Equal(TypeArgumentKind.Reference, NullabilityImportRule.ClassifyArgument(Parameter("Longer`3", 2)));
        Assert.Equal(TypeArgumentKind.Unknown, NullabilityImportRule.ClassifyArgument(Parameter("Open`2", 1)));

        // The symbol overload answers the same chain the same way.
        var bound = TypeParameter();
        bound.HasReferenceTypeConstraint = true;
        var dependent = new TypeParameterSymbol("T", ordinal: 1, TypeParameterConstraint.Any, TypeParameterVariance.None)
        {
            TypeParameterBound = bound,
        };
        Assert.Equal(TypeArgumentKind.Reference, NullabilityImportRule.ClassifyArgument(dependent));
        var unboundedDependent = new TypeParameterSymbol("T", ordinal: 1, TypeParameterConstraint.Any, TypeParameterVariance.None)
        {
            TypeParameterBound = TypeParameter(),
        };
        Assert.Equal(TypeArgumentKind.Unknown, NullabilityImportRule.ClassifyArgument(unboundedDependent));
    }

    private static TypeParameterSymbol TypeParameter()
        => new("T", ordinal: 0, TypeParameterConstraint.Any, TypeParameterVariance.None);

    /// <summary>Collects the type of every <c>Find</c> call in a bound body.</summary>
    private sealed class FindCallFinder : GSharp.Core.CodeAnalysis.Binding.BoundTreeWalker
    {
        internal System.Collections.Generic.List<TypeSymbol> Types { get; } = new();

        public override void VisitExpression(GSharp.Core.CodeAnalysis.Binding.BoundExpression? node)
        {
            switch (node)
            {
                case GSharp.Core.CodeAnalysis.Binding.BoundImportedInstanceCallExpression call when call.Method.Name == "Find":
                    this.Types.Add(call.Type);
                    break;
                case GSharp.Core.CodeAnalysis.Binding.BoundImportedCallExpression call when call.Function.Name == "Find":
                    this.Types.Add(call.Type);
                    break;
            }

            base.VisitExpression(node);
        }
    }
}
