// <copyright file="NullabilityFunnelAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// GSA0007 (ADR-0193 §3): the producer funnel. It polices the conversion
/// <em>doors</em> — every Core path from a CLR <c>Type</c> (or its nullability
/// metadata) to a <c>TypeSymbol</c> — rather than the arguments passed to
/// them, because an argument-shape rule cannot hold across a helper
/// boundary.
/// <list type="bullet">
/// <item>A call to (or method-group reference of) a door outside a member
/// marked <c>[NullabilityFunnel]</c> is reported.</item>
/// <item>The named escape hatches — <c>TypeSymbol.FromClrTypeWithoutNullability</c>
/// and its twins <c>ImportedTypeSymbol.GetWithoutNullability</c> and
/// <c>MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability</c>, each taking
/// a required <c>NullabilityFreeReason</c> — are allowed anywhere,
/// except when a <c>System.Type</c> argument is, within the same method, a
/// signature accessor (<c>ReturnType</c>, <c>ReturnParameter</c>,
/// <c>ParameterType</c>, <c>PropertyType</c>, <c>FieldType</c>,
/// <c>EventHandlerType</c>, or anything derived from one, such as
/// <c>GetGenericArguments()</c> or <c>GetElementType()</c>).</item>
/// <item>Inside a funnel member that is not <c>NullabilityImportRule</c>'s,
/// a direct <c>NullableTypeSymbol.Get</c> / <c>PlatformTypeSymbol.Get</c>
/// call is reported: the walkers resolve classified positions through the
/// rule.</item>
/// </list>
/// Exemption is per member, never per type. The rule runs once per operation
/// block, so a lambda or local function is part of the member whose body
/// contains it, and every local's sources are collected from that same body.
/// <para>
/// The rule is self-migrated to G# (ADR-0169), so it sticks to the analyzer
/// surface cs2gs maps: an operation-block action, <c>DescendantsAndSelf()</c>,
/// and symbol reads by <c>Name</c> / <c>ContainingType</c>.
/// </para>
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NullabilityFunnelAnalyzer : DiagnosticAnalyzer
{
    private const string FunnelAttributeName = "NullabilityFunnelAttribute";
    private const string ImportRuleTypeName = "NullabilityImportRule";
    private const string CoreNamespacePrefix = "GSharp.Core";
    private const string SystemTypeName = "global::System.Type";

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.NullabilityFunnelBypass);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterOperationBlockAction(AnalyzeBlock);
    }

    private static void AnalyzeBlock(OperationBlockAnalysisContext context)
    {
        var owner = context.OwningSymbol;
        if (!IsInCore(owner))
        {
            return;
        }

        var isFunnel = IsFunnelMember(owner);
        var isImportRule = owner.ContainingType?.Name == ImportRuleTypeName;

        // Pass 1: where every local in the body gets its value from.
        var sources = new Dictionary<ISymbol, List<IOperation>>(SymbolEqualityComparer.Default);
        foreach (var block in context.OperationBlocks)
        {
            foreach (var node in block.DescendantsAndSelf())
            {
                if (node is IVariableDeclaratorOperation declarator)
                {
                    var initializer = declarator.Initializer;
                    if (initializer != null)
                    {
                        AddSource(sources, declarator.Symbol, initializer.Value);
                    }
                }
                else if (node is IAssignmentOperation assignment)
                {
                    if (assignment.Target is ILocalReferenceOperation assigned)
                    {
                        AddSource(sources, assigned.Local, assignment.Value);
                    }
                }
                else if (node is IForEachLoopOperation loop)
                {
                    foreach (var loopLocal in loop.Locals)
                    {
                        AddSource(sources, loopLocal, loop.Collection);
                    }
                }
                else if (node is IInvocationOperation producer)
                {
                    // `out var t`: the call that fills the local is its source.
                    foreach (var argument in producer.Arguments)
                    {
                        if (argument.Value is IDeclarationExpressionOperation declaration
                            && declaration.Expression is ILocalReferenceOperation declared)
                        {
                            AddSource(sources, declared.Local, producer);
                        }
                    }
                }
            }
        }

        // Pass 2: every door, escape hatch and wrapper factory in the body.
        foreach (var block in context.OperationBlocks)
        {
            foreach (var node in block.DescendantsAndSelf())
            {
                if (node is IInvocationOperation invocation)
                {
                    AnalyzeCall(context, invocation.TargetMethod, invocation, isFunnel, isImportRule, sources);
                }
                else if (node is IMethodReferenceOperation reference)
                {
                    AnalyzeMethodGroup(context, reference.Method, reference, isFunnel, isImportRule);
                }
            }
        }
    }

    private static void AddSource(Dictionary<ISymbol, List<IOperation>> sources, ISymbol local, IOperation value)
    {
        if (!sources.TryGetValue(local, out var list))
        {
            list = new List<IOperation>();
            sources[local] = list;
        }

        list.Add(value);
    }

    private static void AnalyzeCall(
        OperationBlockAnalysisContext context,
        ISymbol target,
        IInvocationOperation invocation,
        bool isFunnel,
        bool isImportRule,
        Dictionary<ISymbol, List<IOperation>> sources)
    {
        if (IsEscapeHatch(target))
        {
            // Every System.Type argument is checked, whatever its position or
            // name: an escape hatch's type argument is one of them.
            foreach (var argument in invocation.Arguments)
            {
                var value = argument.Value;
                if (IsSystemType(value.Type)
                    && DerivesFromSignatureAccessor(value, sources, new HashSet<ISymbol>(SymbolEqualityComparer.Default)))
                {
                    Report(context, invocation, $"'{target.Name}' is given a member signature position; read it through a funnel reader (ClrNullability.Get*TypeSymbol or MemberLookup.GetClr*TypeSymbol) so its declaration nullability is merged");
                    return;
                }
            }

            return;
        }

        AnalyzeDoorOrFactory(context, target, invocation, isFunnel, isImportRule);
    }

    private static void AnalyzeMethodGroup(
        OperationBlockAnalysisContext context,
        ISymbol? target,
        IOperation reference,
        bool isFunnel,
        bool isImportRule)
    {
        // G#'s method-group surface reports no method for an empty group.
        if (target == null)
        {
            return;
        }

        // A method group (`.Select(TypeSymbol.FromClrType)`) calls the door on
        // arguments the analyzer cannot see, so it is reported as a call. The
        // escape hatch passed as a group is reported too: its argument is
        // unknowable here, so the signature-accessor check cannot pass.
        if (IsEscapeHatch(target))
        {
            Report(context, reference, $"'{target.Name}' is used as a method group, so its argument cannot be checked; call it directly with the Type in hand");
            return;
        }

        AnalyzeDoorOrFactory(context, target, reference, isFunnel, isImportRule);
    }

    private static void AnalyzeDoorOrFactory(
        OperationBlockAnalysisContext context,
        ISymbol target,
        IOperation operation,
        bool isFunnel,
        bool isImportRule)
    {
        if (IsDoor(target))
        {
            if (!isFunnel)
            {
                Report(context, operation, $"'{target.ContainingType?.Name}.{target.Name}' is a nullability conversion door and may only be called from a [NullabilityFunnel] member; read signature positions through a funnel reader, or use TypeSymbol.FromClrTypeWithoutNullability with a NullabilityFreeReason");
            }

            return;
        }

        if (isFunnel && !isImportRule && IsWrapperFactory(target))
        {
            Report(context, operation, $"'{target.ContainingType?.Name}.{target.Name}' is called directly inside a [NullabilityFunnel] member; resolve a classified position through NullabilityImportRule instead");
        }
    }

    private static void Report(OperationBlockAnalysisContext context, IOperation operation, string message)
        => context.ReportDiagnostic(Diagnostic.Create(DiagnosticDescriptors.NullabilityFunnelBypass, operation.Syntax.GetLocation(), message));

    private static bool IsInCore(ISymbol? symbol)
    {
        var ns = symbol?.ContainingNamespace?.ToDisplayString();
        return ns != null && (ns == CoreNamespacePrefix || ns.StartsWith(CoreNamespacePrefix + ".", System.StringComparison.Ordinal));
    }

    private static bool IsDoor(ISymbol method)
    {
        if (!IsInCore(method.ContainingType))
        {
            return false;
        }

        var type = method.ContainingType?.Name;
        var name = method.Name;
        return (type == "TypeSymbol" && name == "FromClrType")
            || (type == "MemberLookup" && name == "MapOpenClrTypeToSymbolic")
            || (type == "ImportedTypeSymbol" && name == "Get")
            || (type == "ClrNullability" && (name == "ReadNullableFlags" || name == "ClassifyFlag" || name == "ClassifyPosition"));
    }

    private static bool IsEscapeHatch(ISymbol method)
    {
        if (!IsInCore(method.ContainingType))
        {
            return false;
        }

        var type = method.ContainingType?.Name;
        var name = method.Name;
        return (type == "TypeSymbol" && name == "FromClrTypeWithoutNullability")
            || (type == "ImportedTypeSymbol" && name == "GetWithoutNullability")
            || (type == "MemberLookup" && name == "MapOpenClrTypeToSymbolicWithoutNullability");
    }

    private static bool IsWrapperFactory(ISymbol method)
    {
        var type = method.ContainingType?.Name;
        return method.Name == "Get"
            && (type == "NullableTypeSymbol" || type == "PlatformTypeSymbol")
            && IsInCore(method.ContainingType);
    }

    private static bool IsFunnelMember(ISymbol member)
    {
        if (HasFunnelAttribute(member))
        {
            return true;
        }

        // A property accessor is covered by its property's attribute.
        return member is IMethodSymbol accessor
            && accessor.AssociatedSymbol != null
            && HasFunnelAttribute(accessor.AssociatedSymbol);
    }

    private static bool HasFunnelAttribute(ISymbol symbol)
    {
        foreach (var attribute in symbol.GetAttributes())
        {
            if (attribute.AttributeClass?.Name == FunnelAttributeName)
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsSystemType(ITypeSymbol? type)
        => type != null && type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == SystemTypeName;

    /// <summary>
    /// Whether <paramref name="operation"/> is, or is computed from, a
    /// signature accessor within the same method: directly, or through
    /// locals whose initializers, assignments, <c>foreach</c> collections or
    /// <c>out var</c> producers are.
    /// </summary>
    private static bool DerivesFromSignatureAccessor(
        IOperation operation,
        Dictionary<ISymbol, List<IOperation>> sources,
        HashSet<ISymbol> visited)
    {
        foreach (var node in operation.DescendantsAndSelf())
        {
            if (node is IPropertyReferenceOperation property)
            {
                if (IsSignatureAccessor(property.Property))
                {
                    return true;
                }
            }
            else if (node is ILocalReferenceOperation reference)
            {
                if (visited.Add(reference.Local) && sources.TryGetValue(reference.Local, out var localSources))
                {
                    foreach (var source in localSources)
                    {
                        if (DerivesFromSignatureAccessor(source, sources, visited))
                        {
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    private static bool IsSignatureAccessor(ISymbol? property)
    {
        // G#'s property-read surface reports no property for a field read.
        if (property == null)
        {
            return false;
        }

        var name = property.Name;
        return (name == "ReturnType"
                || name == "ReturnParameter"
                || name == "ParameterType"
                || name == "PropertyType"
                || name == "FieldType"
                || name == "EventHandlerType")
            && property.ContainingType?.ContainingNamespace?.ToDisplayString() == "System.Reflection";
    }
}
