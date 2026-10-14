// <copyright file="NullabilityFunnelAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// GSA0007 (ADR-0193 §3): the producer funnel. It polices the conversion
/// <em>doors</em> — every Core path from a CLR `Type` (or its nullability
/// metadata) to a `TypeSymbol` — rather than the arguments passed to
/// them, because an argument-shape rule cannot hold across a helper
/// boundary.
/// - A call to (or method-group reference of) a door outside a member marked `[NullabilityFunnel]` is
/// reported.
/// - The named escape hatches — `TypeSymbol.FromClrTypeWithoutNullability` and its twins
/// `ImportedTypeSymbol.GetWithoutNullability` and
/// `MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability`, each taking a required
/// `NullabilityFreeReason` — are allowed anywhere, except when a `System.Type` argument is, within the
/// same method, a signature accessor (`ReturnType`, `ReturnParameter`, `ParameterType`, `PropertyType`,
/// `FieldType`, `EventHandlerType`, or anything derived from one, such as `GetGenericArguments()` or
/// `GetElementType()`).
/// - Inside a funnel member that is not `NullabilityImportRule`'s, a direct `NullableTypeSymbol.Get` /
/// `PlatformTypeSymbol.Get` call is reported: the walkers resolve classified positions through the
/// rule.
/// Exemption is per member, never per type. The rule runs once per operation
/// block, so a lambda or local function is part of the member whose body
/// contains it, and every local's sources are collected from that same body.
///
/// The rule is self-migrated to G# (ADR-0169), so it sticks to the analyzer
/// surface cs2gs maps: an operation-block action, `DescendantsAndSelf()`,
/// and symbol reads by `Name` / `ContainingType`.
@GSharpDiagnosticAnalyzer
class NullabilityFunnelAnalyzer : GSharpDiagnosticAnalyzer {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _supportedDiagnostics ImmutableArray[DiagnosticDescriptor] = ImmutableArray.Create(
        DiagnosticDescriptors.NullabilityFunnelBypass
    )

    override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> _supportedDiagnostics

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Initialize(context AnalysisContext) {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None)
        context.EnableConcurrentExecution()
        context.RegisterBoundBodyAction(AnalyzeBlock)
    }

    shared {
        private const FunnelAttributeName string = "NullabilityFunnelAttribute"
        private const ImportRuleTypeName string = "NullabilityImportRule"
        private const CoreNamespacePrefix string = "GSharp.Core"
        private const SystemTypeName string = "global::System.Type"

        private func AnalyzeBlock(context BoundBodyAnalysisContext) {
            let owner = context.OwningSymbol
            if !IsInCore(owner) {
                return
            }
            let isFunnel = IsFunnelMember(owner)
            let isImportRule = owner.ContainingType?.Name == ImportRuleTypeName
            // Pass 1: where every local in the body gets its value from.
            let sources = Dictionary[Symbol, List[BoundExpression]](SymbolEqualityComparer.Default)
            for block in context.Bodies {
                for node in block.DescendantsAndSelf() {
                    if node is BoundVariableDeclaration declarator {
                        let initializer BoundExpression? = declarator.Initializer
                        if initializer != nil {
                            AddSource(sources, declarator.Variable, initializer)
                        }
                    } else if node is BoundAssignmentExpression assignment {
                        // A reassigned parameter is a source exactly as a local is.
                        let assigned Symbol? = VariableOf(assignment.Target)
                        if assigned != nil {
                            AddSource(sources, assigned, assignment.Value)
                        }
                    } else if node is BoundForRangeStatement loop {
                        for loopLocal in loop.Locals {
                            AddSource(sources, loopLocal, loop.Collection)
                        }
                    } else if node is BoundCallOperationExpression producer {
                        // `out var t`: the call that fills the local is its source.
                        for argument in producer.Arguments {
                            if argument is BoundAddressOfExpression declaration &&
                                declaration.Operand is BoundVariableExpression declared {
                                AddSource(sources, declared.Variable, producer)
                            }
                        }
                    }
                }
            }
            // Pass 2: every door, escape hatch and wrapper factory in the body.
            for block in context.Bodies {
                for node in block.DescendantsAndSelf() {
                    if node is BoundCallOperationExpression invocation {
                        AnalyzeCall(context, invocation.CalledFunction, invocation, isFunnel, isImportRule, sources)
                    } else if node is BoundMethodReferenceOperationExpression reference {
                        AnalyzeMethodGroup(context, reference.Method, reference, isFunnel, isImportRule)
                    }
                }
            }
        }

        private func AddSource(sources Dictionary[Symbol, List[BoundExpression]], local Symbol, value BoundExpression) {
            if !sources.TryGetValue(local, out var list) {
                list = List[BoundExpression]()
                sources[local] = list
            }
            list.Add(value)
        }

        private func AnalyzeCall(
            context BoundBodyAnalysisContext,
            target Symbol,
            invocation BoundCallOperationExpression,
            isFunnel bool,
            isImportRule bool,
            sources Dictionary[Symbol, List[BoundExpression]]
        ) {
            if IsEscapeHatch(target) {
                // Every System.Type argument is checked, whatever its position or
                // name: an escape hatch's type argument is one of them.
                for argument in invocation.Arguments {
                    let value = argument
                    if IsSystemType(value.Type) &&
                        DerivesFromSignatureAccessor(value, sources, HashSet[Symbol](SymbolEqualityComparer.Default)) {
                        Report(
                            context,
                            invocation,
                            "'${target.Name}' is given a member signature position; read it through a funnel reader (ClrNullability.Get*TypeSymbol or MemberLookup.GetClr*TypeSymbol) so its declaration nullability is merged"
                        )
                        return
                    }
                }
                return
            }
            AnalyzeDoorOrFactory(context, target, invocation, isFunnel, isImportRule)
        }

        private func AnalyzeMethodGroup(
            context BoundBodyAnalysisContext,
            target Symbol?,
            reference BoundExpression,
            isFunnel bool,
            isImportRule bool
        ) {
            // G#'s method-group surface reports no method for an empty group.
            if target == nil {
                return
            }
            // A method group (`.Select(TypeSymbol.FromClrType)`) calls the door on
            // arguments the analyzer cannot see, so it is reported as a call. The
            // escape hatch passed as a group is reported too: its argument is
            // unknowable here, so the signature-accessor check cannot pass.
            if IsEscapeHatch(target) {
                Report(
                    context,
                    reference,
                    "'${target.Name}' is used as a method group, so its argument cannot be checked; call it directly with the Type in hand"
                )
                return
            }
            AnalyzeDoorOrFactory(context, target, reference, isFunnel, isImportRule)
        }

        private func AnalyzeDoorOrFactory(
            context BoundBodyAnalysisContext,
            target Symbol,
            operation BoundExpression,
            isFunnel bool,
            isImportRule bool
        ) {
            if IsDoor(target) {
                if !isFunnel {
                    Report(
                        context,
                        operation,
                        "'${target.ContainingType?.Name}.${target.Name}' is a nullability conversion door and may only be called from a [NullabilityFunnel] member; read signature positions through a funnel reader, or use TypeSymbol.FromClrTypeWithoutNullability with a NullabilityFreeReason"
                    )
                }
                return
            }
            if isFunnel && !isImportRule && IsWrapperFactory(target) {
                Report(
                    context,
                    operation,
                    "'${target.ContainingType?.Name}.${target.Name}' is called directly inside a [NullabilityFunnel] member; resolve a classified position through NullabilityImportRule instead"
                )
            }
        }

        private func Report(context BoundBodyAnalysisContext, operation BoundExpression, message string) -> context
            .ReportDiagnostic(
            Diagnostic.Create(DiagnosticDescriptors.NullabilityFunnelBypass, operation.Syntax!!.Location, message)
        )

        private func IsInCore(symbol Symbol?) bool {
            let ns string? = symbol?.ContainingNamespace
            return ns != nil &&
                (ns == CoreNamespacePrefix || ns.StartsWith(CoreNamespacePrefix + ".", StringComparison.Ordinal))
        }

        private func IsDoor(method Symbol) bool {
            if !IsInCore(method.ContainingType) {
                return false
            }
            let type = method.ContainingType?.Name
            let name = method.Name
            return (type == "TypeSymbol" && name == "FromClrType") ||
                (type == "MemberLookup" && name == "MapOpenClrTypeToSymbolic") ||
                (type == "ImportedTypeSymbol" && name == "Get") ||
                (
                type == "ClrNullability" &&
                    (name == "ReadNullableFlags" || name == "ClassifyFlag" || name == "ClassifyPosition")
            )
        }

        private func IsEscapeHatch(method Symbol) bool {
            if !IsInCore(method.ContainingType) {
                return false
            }
            let type = method.ContainingType?.Name
            let name = method.Name
            return (type == "TypeSymbol" && name == "FromClrTypeWithoutNullability") ||
                (type == "ImportedTypeSymbol" && name == "GetWithoutNullability") ||
                (type == "MemberLookup" && name == "MapOpenClrTypeToSymbolicWithoutNullability")
        }

        private func IsWrapperFactory(method Symbol) bool {
            let type = method.ContainingType?.Name
            return method.Name == "Get" &&
                (type == "NullableTypeSymbol" || type == "PlatformTypeSymbol") &&
                IsInCore(method.ContainingType)
        }

        private func IsFunnelMember(member Symbol) bool {
            if HasFunnelAttribute(member) {
                return true
            }
            // A property accessor is covered by its property's attribute.
            return member is FunctionSymbol accessor &&
                accessor.AssociatedSymbol != nil &&
                HasFunnelAttribute(accessor.AssociatedSymbol!!)
        }

        private func HasFunnelAttribute(symbol Symbol) bool {
            for attribute in symbol.GetAttributes() {
                if attribute.AttributeClass?.Name == FunnelAttributeName {
                    return true
                }
            }
            return false
        }

        private func IsSystemType(type TypeSymbol?) bool -> type != nil && type.ToDisplayString(
            DisplayFormat.FullyQualified
        ) == SystemTypeName

        /// Whether [`operation`](paramref) is, or is computed from, a
        /// signature accessor within the same method: directly, or through
        /// locals whose initializers, assignments, `foreach` collections or
        /// `out var` producers are.
        private func DerivesFromSignatureAccessor(
            operation BoundExpression,
            sources Dictionary[Symbol, List[BoundExpression]],
            visited HashSet[Symbol]
        ) bool {
            for node in operation.DescendantsAndSelf() {
                if node is BoundPropertyReferenceOperationExpression property {
                    if IsSignatureAccessor(property.ReferencedProperty) {
                        return true
                    }
                } else if node is BoundVariableExpression local {
                    if DerivesThroughVariable(local.Variable, sources, visited) {
                        return true
                    }
                } else if node is BoundVariableExpression parameter {
                    // A reassigned parameter is traced exactly as a local is.
                    if DerivesThroughVariable(parameter.Variable, sources, visited) {
                        return true
                    }
                }
            }
            return false
        }

        private func DerivesThroughVariable(
            variable Symbol,
            sources Dictionary[Symbol, List[BoundExpression]],
            visited HashSet[Symbol]
        ) bool {
            if visited.Add(variable) && sources.TryGetValue(variable, out var variableSources) {
                for source in variableSources {
                    if DerivesFromSignatureAccessor(source, sources, visited) {
                        return true
                    }
                }
            }
            return false
        }

        // The local or parameter a reference reads or writes, or null.
        private func VariableOf(operation BoundExpression) Symbol? {
            if operation is BoundVariableExpression local {
                return local.Variable
            }
            if operation is BoundVariableExpression parameter {
                return parameter.Variable
            }
            return nil
        }

        private func IsSignatureAccessor(property Symbol?) bool {
            // G#'s property-read surface reports no property for a field read.
            if property == nil {
                return false
            }
            let name = property.Name
            return (
                name == "ReturnType" ||
                    name == "ReturnParameter" ||
                    name == "ParameterType" ||
                    name == "PropertyType" ||
                    name == "FieldType" ||
                    name == "EventHandlerType"
            ) &&
                property
                .ContainingType
                ?.ContainingNamespace == "System.Reflection"
        }
    }
}
