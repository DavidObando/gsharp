// <copyright file="NullabilityFunnelAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using Xunit;

namespace GSharp.InternalAnalyzers.Tests;

/// <summary>
/// GSA0007 (ADR-0193 §3): the producer funnel. The real list of attributed
/// members is pinned by <c>Adr0193NullabilityFunnelMembersTests</c> in
/// Core.Tests, which reflects over the compiled compiler.
/// </summary>
public sealed class NullabilityFunnelAnalyzerTests
{
    // A minimal stand-in for the Core types the analyzer matches by name.
    private const string Stubs = """
using System;
using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols
{
    [AttributeUsage(AttributeTargets.Method | AttributeTargets.Constructor | AttributeTargets.Property)]
    sealed class NullabilityFunnelAttribute : Attribute { }

    enum NullabilityFreeReason { TypeLiteral, TypeStructure }

    class TypeSymbol
    {
        [NullabilityFunnel]
        public static TypeSymbol FromClrType(Type t) => new TypeSymbol();

        [NullabilityFunnel]
        internal static TypeSymbol FromClrTypeWithoutNullability(Type t, NullabilityFreeReason reason) => FromClrType(t);
    }

    class ImportedTypeSymbol : TypeSymbol
    {
        [NullabilityFunnel]
        public static ImportedTypeSymbol Get(Type t) => new ImportedTypeSymbol();

        public static ImportedTypeSymbol Get(string name) => new ImportedTypeSymbol();

        [NullabilityFunnel]
        internal static ImportedTypeSymbol GetWithoutNullability(Type t, NullabilityFreeReason reason) => Get(t);
    }

    class NullableTypeSymbol : TypeSymbol
    {
        public static NullableTypeSymbol Get(TypeSymbol t) => new NullableTypeSymbol();
    }

    class PlatformTypeSymbol : TypeSymbol
    {
        public static TypeSymbol Get(TypeSymbol t) => t;
    }

    enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

    static class ClrNullability
    {
        [NullabilityFunnel]
        internal static ImmutableArray<byte> ReadNullableFlags(ICustomAttributeProvider p, MemberInfo m) => default;

        [NullabilityFunnel]
        internal static ClrNullabilityState ClassifyFlag(byte b) => default;

        [NullabilityFunnel]
        internal static ClrNullabilityState ClassifyPosition(ImmutableArray<byte> f, int i) => ClassifyFlag(0);

        public static TypeSymbol GetReturnTypeSymbol(MethodInfo m) => new TypeSymbol();
    }

    static class NullabilityImportRule
    {
        [NullabilityFunnel]
        internal static TypeSymbol ApplyConcrete(TypeSymbol t, ClrNullabilityState s)
            => s == ClrNullabilityState.Annotated ? NullableTypeSymbol.Get(t) : PlatformTypeSymbol.Get(t);
    }
}

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    static class MemberLookup
    {
        [NullabilityFunnel]
        public static TypeSymbol MapOpenClrTypeToSymbolic(Type t, Type d, ImmutableArray<TypeSymbol> a) => TypeSymbol.FromClrType(t);

        [NullabilityFunnel]
        internal static TypeSymbol MapOpenClrTypeToSymbolicWithoutNullability(Type t, Type d, ImmutableArray<TypeSymbol> a, NullabilityFreeReason reason)
            => MapOpenClrTypeToSymbolic(t, d, a);
    }
}
""";

    [Fact]
    public Task ReportsEveryDoorCalledOutsideAFunnelMember()
    {
        const string Source = Stubs + """
namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using System.Collections.Immutable;
    using System.Reflection;
    using GSharp.Core.CodeAnalysis.Symbols;

    class Consumer
    {
        void Use(Type t, MethodInfo m)
        {
            _ = [|TypeSymbol.FromClrType(t)|];
            _ = [|MemberLookup.MapOpenClrTypeToSymbolic(t, null, default)|];
            _ = [|ImportedTypeSymbol.Get(t)|];
            var flags = [|ClrNullability.ReadNullableFlags(m.ReturnParameter, m)|];
            _ = [|ClrNullability.ClassifyPosition(flags, 0)|];
            _ = [|ClrNullability.ClassifyFlag(1)|];
            _ = ImportedTypeSymbol.Get("not a CLR Type overload");
            _ = ClrNullability.GetReturnTypeSymbol(m);
        }
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(
            new NullabilityFunnelAnalyzer(),
            Source,
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007");
    }

    [Fact]
    public Task FunnelMembersIncludingTheirLambdasLocalFunctionsAndAccessorsPass()
    {
        const string Source = Stubs + """
namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using System.Linq;
    using GSharp.Core.CodeAnalysis.Symbols;

    class Reader
    {
        [NullabilityFunnel]
        TypeSymbol Read(Type[] types)
        {
            var mapped = types.Select(t => TypeSymbol.FromClrType(t)).ToArray();
            return Local(types[0]);

            TypeSymbol Local(Type t) => TypeSymbol.FromClrType(t);
        }

        [NullabilityFunnel]
        TypeSymbol Shape => TypeSymbol.FromClrType(typeof(string));
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new NullabilityFunnelAnalyzer(), Source);
    }

    [Fact]
    public Task ExemptionIsPerMemberNotPerType()
    {
        // A sibling member of an attributed one — even in the door-defining
        // type itself — is checked like any other code.
        const string Source = Stubs + """
namespace GSharp.Core.CodeAnalysis.Symbols
{
    using System;

    partial class TypeSymbolExtras
    {
        [NullabilityFunnel]
        TypeSymbol Allowed(Type t) => TypeSymbol.FromClrType(t);

        TypeSymbol NotAllowed(Type t) => [|TypeSymbol.FromClrType(t)|];
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new NullabilityFunnelAnalyzer(), Source, "GSA0007");
    }

    [Fact]
    public Task ReportsADoorPassedAsAMethodGroup()
    {
        const string Source = Stubs + """
namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using System.Linq;
    using GSharp.Core.CodeAnalysis.Symbols;

    class Consumer
    {
        TypeSymbol[] Map(Type[] types) => types.Select([|TypeSymbol.FromClrType|]).ToArray();

        Func<Type, NullabilityFreeReason, TypeSymbol> Escape() => [|TypeSymbol.FromClrTypeWithoutNullability|];
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new NullabilityFunnelAnalyzer(), Source, "GSA0007", "GSA0007");
    }

    [Fact]
    public Task EscapeHatchIsAllowedForNonSignatureTypes()
    {
        const string Source = Stubs + """
namespace GSharp.Core.CodeAnalysis.Emit
{
    using System;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.Symbols;

    class Emitter
    {
        void Use(TypeSymbol symbol, Type helperResult)
        {
            _ = TypeSymbol.FromClrTypeWithoutNullability(typeof(int), NullabilityFreeReason.TypeLiteral);
            _ = TypeSymbol.FromClrTypeWithoutNullability(symbol.GetType().GetGenericArguments()[0], NullabilityFreeReason.TypeStructure);
            _ = ImportedTypeSymbol.GetWithoutNullability(typeof(string), NullabilityFreeReason.TypeLiteral);
            _ = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(helperResult, null, default, NullabilityFreeReason.TypeStructure);
        }
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new NullabilityFunnelAnalyzer(), Source);
    }

    [Fact]
    public Task EscapeHatchIsReportedOnASignatureAccessorWithinTheMethod()
    {
        const string Source = Stubs + """
namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using System.Reflection;
    using GSharp.Core.CodeAnalysis.Symbols;

    class Consumer
    {
        void Use(MethodInfo method, PropertyInfo property, FieldInfo field, EventInfo evt)
        {
            _ = [|TypeSymbol.FromClrTypeWithoutNullability(method.ReturnType, NullabilityFreeReason.TypeStructure)|];
            _ = [|TypeSymbol.FromClrTypeWithoutNullability(reason: NullabilityFreeReason.TypeStructure, t: method.ReturnType)|];
            _ = [|TypeSymbol.FromClrTypeWithoutNullability(method.ReturnParameter.ParameterType, NullabilityFreeReason.TypeStructure)|];
            _ = [|TypeSymbol.FromClrTypeWithoutNullability(method.GetParameters()[0].ParameterType.GetElementType(), NullabilityFreeReason.TypeStructure)|];
            _ = [|TypeSymbol.FromClrTypeWithoutNullability(property.PropertyType.GetGenericArguments()[0], NullabilityFreeReason.TypeStructure)|];
            _ = [|ImportedTypeSymbol.GetWithoutNullability(field.FieldType, NullabilityFreeReason.TypeStructure)|];
            _ = [|MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(evt.EventHandlerType, null, default, NullabilityFreeReason.TypeStructure)|];

            var local = method.ReturnType;
            var element = local.GetElementType();
            _ = [|TypeSymbol.FromClrTypeWithoutNullability(element, NullabilityFreeReason.TypeStructure)|];

            Type assigned;
            assigned = property.PropertyType;
            _ = [|TypeSymbol.FromClrTypeWithoutNullability(assigned, NullabilityFreeReason.TypeStructure)|];

            foreach (var parameter in method.GetParameters())
            {
                _ = [|TypeSymbol.FromClrTypeWithoutNullability(parameter.ParameterType, NullabilityFreeReason.TypeStructure)|];
            }

            foreach (var argument in method.ReturnType.GetGenericArguments())
            {
                _ = [|TypeSymbol.FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure)|];
            }

            Split(field.FieldType, out var fromOut);
            _ = [|TypeSymbol.FromClrTypeWithoutNullability(fromOut, NullabilityFreeReason.TypeStructure)|];
        }

        static void Split(Type type, out Type result) => result = type;
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(
            new NullabilityFunnelAnalyzer(),
            Source,
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007");
    }

    [Fact]
    public Task WrapperFactoriesAreReportedInsideFunnelWalkersOnly()
    {
        const string Source = Stubs + """
namespace GSharp.Core.CodeAnalysis.Symbols
{
    using System;

    static class Walker
    {
        [NullabilityFunnel]
        static TypeSymbol Walk(Type t)
        {
            var mapped = TypeSymbol.FromClrType(t);
            _ = [|NullableTypeSymbol.Get(mapped)|];
            return [|PlatformTypeSymbol.Get(mapped)|];
        }

        // Outside the funnel the language wraps types it already has (the
        // `?.` result, a nil arm): not a door.
        static TypeSymbol Language(TypeSymbol t) => NullableTypeSymbol.Get(t);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new NullabilityFunnelAnalyzer(), Source, "GSA0007", "GSA0007");
    }

    [Fact]
    public Task IgnoresCodeOutsideCore()
    {
        const string Source = Stubs + """
namespace GSharp.Cs2Gs.Tests
{
    using System;
    using GSharp.Core.CodeAnalysis.Symbols;

    class Test
    {
        TypeSymbol Probe(Type t) => TypeSymbol.FromClrType(t);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new NullabilityFunnelAnalyzer(), Source);
    }

    [Fact]
    public Task CatchesTheHistoricalSymbolicReturnGap()
    {
        // ADR-0193: `ResolveCallReturnTypeFromSymbolicTypeArgs` projected an
        // open generic return through symbolic method type arguments and
        // returned it with no declaration-nullability merge (#4361, deferred
        // by PR #4362 round 3). The same shape, un-suppressed, is reported.
        const string Source = Stubs + """
namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.Collections.Immutable;
    using System.Reflection;
    using GSharp.Core.CodeAnalysis.Symbols;

    static class Lookup
    {
        public static TypeSymbol ResolveCallReturnTypeFromSymbolicTypeArgs(MethodInfo closed, ImmutableArray<TypeSymbol> args)
        {
            var openMethod = closed.GetGenericMethodDefinition();
            return [|MemberLookup.MapOpenClrTypeToSymbolic(openMethod.ReturnType, null, args)|];
        }
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new NullabilityFunnelAnalyzer(), Source, "GSA0007");
    }
}
