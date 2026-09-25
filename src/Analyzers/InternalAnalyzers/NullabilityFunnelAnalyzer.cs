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
/// except when its argument is, within the same method, a signature accessor
/// (<c>ReturnType</c>, <c>ReturnParameter</c>, <c>ParameterType</c>,
/// <c>PropertyType</c>, <c>FieldType</c>, <c>EventHandlerType</c>, or
/// anything derived from one, such as <c>GetGenericArguments()</c> or
/// <c>GetElementType()</c>).</item>
/// <item>Inside a funnel member that is not <c>NullabilityImportRule</c>'s,
/// a direct <c>NullableTypeSymbol.Get</c> / <c>PlatformTypeSymbol.Get</c>
/// call is reported: the walkers resolve classified positions through the
/// rule.</item>
/// </list>
/// Exemption is per member, never per type. Lambdas and local functions are
/// part of the member that contains them.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NullabilityFunnelAnalyzer : DiagnosticAnalyzer
{
    private const string FunnelAttributeName = "NullabilityFunnelAttribute";
    private const string EscapeHatchSuffix = "WithoutNullability";
    private const string ReasonTypeName = "NullabilityFreeReason";
    private const string ImportRuleTypeName = "NullabilityImportRule";
    private const string CoreNamespacePrefix = "GSharp.Core";

    private static readonly ImmutableHashSet<string> SignatureAccessors = ImmutableHashSet.Create(
        "ReturnType",
        "ReturnParameter",
        "ParameterType",
        "PropertyType",
        "FieldType",
        "EventHandlerType");

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.NullabilityFunnelBypass);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterOperationAction(AnalyzeInvocation, OperationKind.Invocation);
        context.RegisterOperationAction(AnalyzeMethodReference, OperationKind.MethodReference);
    }

    private static void AnalyzeInvocation(OperationAnalysisContext context)
    {
        var invocation = (IInvocationOperation)context.Operation;
        Analyze(context, invocation.TargetMethod, invocation, invocation.Arguments.Length > 0 ? invocation.Arguments[0].Value : null);
    }

    private static void AnalyzeMethodReference(OperationAnalysisContext context)
    {
        var reference = (IMethodReferenceOperation)context.Operation;

        // A method group (`.Select(TypeSymbol.FromClrType)`) calls the door on
        // arguments the analyzer cannot see, so it is reported as a call. The
        // escape hatch passed as a group is reported too: its argument is
        // unknowable here, so the signature-accessor check cannot pass.
        Analyze(context, reference.Method, reference, argument: null);
    }

    private static void Analyze(OperationAnalysisContext context, IMethodSymbol target, IOperation operation, IOperation? argument)
    {
        if (!IsInCore(context.ContainingSymbol))
        {
            return;
        }

        var member = GetEnclosingMember(context.ContainingSymbol);
        if (IsEscapeHatch(target))
        {
            if (argument == null)
            {
                Report(context, operation, $"'{target.Name}' is used as a method group, so its argument cannot be checked; call it directly with the Type in hand");
                return;
            }

            if (DerivesFromSignatureAccessor(argument, operation, new HashSet<ISymbol>(SymbolEqualityComparer.Default)))
            {
                Report(context, operation, $"'{target.Name}' is given a member signature position; read it through a funnel reader (ClrNullability.Get*TypeSymbol or MemberLookup.GetClr*TypeSymbol) so its declaration nullability is merged");
            }

            return;
        }

        if (IsDoor(target))
        {
            if (!IsFunnelMember(member))
            {
                Report(context, operation, $"'{target.ContainingType.Name}.{target.Name}' is a nullability conversion door and may only be called from a [NullabilityFunnel] member; read signature positions through a funnel reader, or use TypeSymbol.FromClrTypeWithoutNullability with a NullabilityFreeReason");
            }

            return;
        }

        if (IsWrapperFactory(target) && IsFunnelMember(member) && !IsImportRuleMember(member))
        {
            Report(context, operation, $"'{target.ContainingType.Name}.{target.Name}' is called directly inside a [NullabilityFunnel] member; resolve a classified position through NullabilityImportRule instead");
        }
    }

    private static void Report(OperationAnalysisContext context, IOperation operation, string message)
        => context.ReportDiagnostic(Diagnostic.Create(DiagnosticDescriptors.NullabilityFunnelBypass, operation.Syntax.GetLocation(), message));

    private static bool IsInCore(ISymbol? symbol)
    {
        var ns = symbol?.ContainingNamespace?.ToDisplayString();
        return ns != null && (ns == CoreNamespacePrefix || ns.StartsWith(CoreNamespacePrefix + ".", System.StringComparison.Ordinal));
    }

    private static bool IsDoor(IMethodSymbol method)
    {
        var type = method.ContainingType?.Name;
        var isDoor = (type, method.Name) switch
        {
            ("TypeSymbol", "FromClrType") => true,
            ("MemberLookup", "MapOpenClrTypeToSymbolic") => true,
            ("ImportedTypeSymbol", "Get") => IsTypeParameterList(method),
            ("ClrNullability", "ReadNullableFlags") => true,
            ("ClrNullability", "ClassifyFlag") => true,
            ("ClrNullability", "ClassifyPosition") => true,
            _ => false,
        };

        return isDoor && IsInCore(method.ContainingType);
    }

    private static bool IsTypeParameterList(IMethodSymbol method)
        => method.Parameters.Length == 1
            && method.Parameters[0].Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == "global::System.Type";

    private static bool IsEscapeHatch(IMethodSymbol method)
        => method.Name.EndsWith(EscapeHatchSuffix, System.StringComparison.Ordinal)
            && method.Parameters.Any(p => p.Type.Name == ReasonTypeName)
            && IsInCore(method.ContainingType);

    private static bool IsWrapperFactory(IMethodSymbol method)
        => method.Name == "Get"
            && method.ContainingType?.Name is "NullableTypeSymbol" or "PlatformTypeSymbol"
            && IsInCore(method.ContainingType);

    private static ISymbol? GetEnclosingMember(ISymbol? symbol)
    {
        while (symbol is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction })
        {
            symbol = symbol.ContainingSymbol;
        }

        return symbol;
    }

    private static bool IsFunnelMember(ISymbol? member)
    {
        if (member == null)
        {
            return false;
        }

        if (HasFunnelAttribute(member))
        {
            return true;
        }

        return member is IMethodSymbol { AssociatedSymbol: { } associated } && HasFunnelAttribute(associated);
    }

    private static bool HasFunnelAttribute(ISymbol symbol)
        => symbol.GetAttributes().Any(a => a.AttributeClass?.Name == FunnelAttributeName);

    private static bool IsImportRuleMember(ISymbol? member)
        => member?.ContainingType?.Name == ImportRuleTypeName;

    /// <summary>
    /// Whether <paramref name="operation"/> is, or is computed from, a
    /// signature accessor within the same method: directly, or through
    /// locals whose initializers, assignments or <c>foreach</c> collections
    /// are.
    /// </summary>
    private static bool DerivesFromSignatureAccessor(IOperation operation, IOperation site, HashSet<ISymbol> visited)
    {
        foreach (var node in DescendantsAndSelf(operation))
        {
            switch (node)
            {
                case IPropertyReferenceOperation property when IsSignatureAccessor(property.Property):
                    return true;
                case ILocalReferenceOperation local when visited.Add(local.Local):
                    foreach (var source in SourcesOf(local.Local, site))
                    {
                        if (DerivesFromSignatureAccessor(source, site, visited))
                        {
                            return true;
                        }
                    }

                    break;
            }
        }

        return false;
    }

    private static bool IsSignatureAccessor(IPropertySymbol property)
        => SignatureAccessors.Contains(property.Name)
            && property.ContainingType?.ContainingNamespace?.ToDisplayString() == "System.Reflection";

    private static IEnumerable<IOperation> SourcesOf(ILocalSymbol local, IOperation site)
    {
        var root = site;
        while (root.Parent != null)
        {
            root = root.Parent;
        }

        foreach (var node in DescendantsAndSelf(root))
        {
            switch (node)
            {
                case IVariableDeclaratorOperation declarator
                    when SymbolEqualityComparer.Default.Equals(declarator.Symbol, local) && declarator.GetVariableInitializer() is { } initializer:
                    yield return initializer.Value;
                    break;
                case IAssignmentOperation assignment
                    when assignment.Target is ILocalReferenceOperation target && SymbolEqualityComparer.Default.Equals(target.Local, local):
                    yield return assignment.Value;
                    break;
                case IForEachLoopOperation loop when loop.Locals.Contains(local, SymbolEqualityComparer.Default):
                    yield return loop.Collection;
                    break;
                case IDeclarationExpressionOperation declaration when ContainsLocal(declaration, local):
                    // `out var t` / deconstruction: the producer is the
                    // enclosing call or assignment.
                    var producer = declaration.Parent;
                    while (producer != null && producer is not (IInvocationOperation or IAssignmentOperation))
                    {
                        producer = producer.Parent;
                    }

                    if (producer != null)
                    {
                        yield return producer;
                    }

                    break;
            }
        }
    }

    private static bool ContainsLocal(IOperation operation, ILocalSymbol local)
        => DescendantsAndSelf(operation).OfType<ILocalReferenceOperation>()
            .Any(r => SymbolEqualityComparer.Default.Equals(r.Local, local));

    private static IEnumerable<IOperation> DescendantsAndSelf(IOperation operation)
    {
        var stack = new Stack<IOperation>();
        stack.Push(operation);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            yield return current;
            foreach (var child in current.ChildOperations)
            {
                stack.Push(child);
            }
        }
    }
}
