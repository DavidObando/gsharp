// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq

internal class NativeProtocolOperations {
    private init(
        protocol TypeSymbol,
        support StructSymbol,
        validate FunctionSymbol,
        payload FunctionSymbol,
        present FunctionSymbol
    ) {
        Protocol = protocol
        Support = support
        Validate = validate
        Payload = payload
        Present = present
    }

    internal prop Protocol TypeSymbol {
        get;
    }
    internal prop Support StructSymbol {
        get;
    }
    internal prop Validate FunctionSymbol {
        get;
    }
    internal prop Payload FunctionSymbol {
        get;
    }
    internal prop Present FunctionSymbol {
        get;
    }

    shared {
        internal func GetProtocol(type TypeSymbol) TypeSymbol? {
            let underlying = PlatformTypeSymbol.StripTopLevel(
                if type is NullableTypeSymbol nullable {
                    nullable.UnderlyingType
                } else {
                    type
                }
            )
            return if NativeProtocolMetadata.IsProtocol(underlying) {
                underlying
            } else {
                nil
            }
        }

        internal func PrepareInput(
            $scope BoundScope,
            source BoundExpression,
            recoverPayload bool,
            requirePresent bool = false
        ) BoundExpression {
            let protocol = GetProtocol(source.Type)
            if protocol == nil {
                return source
            }
            let operations = GetOrCreate($scope, protocol)
            return BoundCallExpression(
                source.Syntax,
                if recoverPayload {
                    operations.Payload
                } else {
                    if requirePresent {
                        operations.Present
                    } else {
                        operations.Validate
                    }
                },
                ImmutableArray.Create(source)
            )
        }

        internal func RequireCoverage(
            $scope BoundScope,
            source TypeSymbol,
            target TypeSymbol,
            location TextLocation,
            positive bool = false
        ) -> $scope
            .GetStructuralAdapterRegistry()
            .ProtocolQueries
            .Add(NativeProtocolQuery(source, target, positive, location))

        internal func NegativeProbe($scope BoundScope, source BoundExpression, protocol TypeSymbol) BoundExpression {
            let registry = $scope.GetStructuralAdapterRegistry()
            let operations = GetOrCreate($scope, protocol)
            let method = FunctionSymbol(
                "Absent${registry.Counter++}",
                ImmutableArray.Create(ParameterSymbol("value", source.Type)),
                NullableTypeSymbol.Get(protocol),
                declaration: nil,
                $package: nil,
                Accessibility.Internal
            ){IsStatic = true, StaticOwnerType = operations.Support}
            operations.Support.SetStaticMethods(operations.Support.StaticMethods.Add(method))
            registry.MethodBodies[method] = Lowerer.Lower(
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundReturnStatement(
                            nil,
                            BoundConversionExpression(
                                nil,
                                method.Type,
                                BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                            )
                        )
                    )
                )
            )
            return BoundCallExpression(source.Syntax, method, ImmutableArray.Create(source))
        }

        internal func GetOrCreate($scope BoundScope, protocol TypeSymbol) NativeProtocolOperations {
            let registry = $scope.GetStructuralAdapterRegistry()
            if registry.ProtocolOperations.TryGetValue(protocol, out var existing) {
                return existing
            }
            let support = StructSymbol(
                "<>ProtocolOperations${registry.Counter++}",
                ImmutableArray[FieldSymbol].Empty,
                Accessibility.Internal,
                declaration: nil,
                protocol.ContainingNamespace ?? string.Empty,
                isData: false,
                isInline: false,
                isClass: true
            )
            let parameter = ParameterSymbol("value", NullableTypeSymbol.Get(protocol))
            support.IsNativeProtocolSupport = true
            let validate = FunctionSymbol(
                "Validate",
                ImmutableArray.Create(parameter),
                parameter.Type,
                declaration: nil,
                $package: nil,
                Accessibility.Internal
            )
            let payload = FunctionSymbol(
                "Payload",
                ImmutableArray.Create(ParameterSymbol("value", parameter.Type)),
                NullableTypeSymbol.Get(TypeSymbol.Object),
                declaration: nil,
                $package: nil,
                Accessibility.Internal
            )
            let present = FunctionSymbol(
                "Present",
                ImmutableArray.Create(ParameterSymbol("value", NullableTypeSymbol.Get(protocol))),
                protocol,
                declaration: nil,
                $package: nil,
                Accessibility.Internal
            )
            let methods = ImmutableArray.Create(validate, payload, present)
            support.SetStaticMethods(methods)
            for method in methods {
                method.IsStatic = true
                method.StaticOwnerType = support
            }
            registry.Types.Add(support)
            let result = NativeProtocolOperations(protocol, support, validate, payload, present)
            registry.ProtocolOperations.Add(protocol, result)
            return result
        }

        internal func Complete($scope BoundScope, diagnostics DiagnosticBag) {
            let registry = $scope.GetStructuralAdapterRegistry()
            for query in registry.ProtocolQueries {
                var known = 0
                for entry in registry.ProtocolEntries.Where(
                    (item NativeProtocolEntryPlan) -> item.Protocols.Contains(query.Source)
                ) {
                    if entry.Protocols.Contains(query.Target) && NativeProtocolMetadata.IsPublic(query.Target) &&
                        !NativeProtocolMetadata
                        .IsPublic(entry.SourceType) {
                        diagnostics.ReportNativeProtocol(
                            query.Location,
                            "public native contracts require an accessible exact payload type; private-payload export is not admitted"
                        )
                    }
                    known++
                    let decision = entry.Decisions.SingleOrDefault(
                        (item NativeProtocolDecision) -> item.Protocol == query.Target
                    )
                    if decision == nil || query.RequirePositive && !decision.Positive {
                        diagnostics.ReportNativeProtocol(
                            query.Location,
                            "incomplete or incompatible native protocol coverage '${entry.SourceType.Name}/${query.Target.Name}'"
                        )
                    }
                }
                for entry in registry.ImportedProtocolEntries.Where(
                    (item ImportedNativeProtocolEntry) ->
                    item.Decisions.TryGetValue(query.Source, out var decision) && decision.Positive
                ) {
                    known++
                    if !entry.Decisions.TryGetValue(query.Target, out var target) ||
                        query.RequirePositive &&
                        !target
                        .Positive {
                        diagnostics.ReportNativeProtocol(
                            query.Location,
                            "unknown or incompatible imported native protocol coverage '${entry.SourceType.Name}/${query.Target.Name}'"
                        )
                    }
                }
                if known == 0 && query.Source != query.Target {
                    diagnostics.ReportNativeProtocol(
                        query.Location,
                        "native protocol query has no validated finite insertion coverage"
                    )
                }
            }
            for operations in registry
                .ProtocolOperations
                .Values
                .OrderBy(
                (item NativeProtocolOperations) -> item.Protocol.ToDisplayString(DisplayFormat.FullyQualified),
                StringComparer.Ordinal
            ) {
                for method in[]FunctionSymbol{operations.Validate, operations.Payload, operations.Present} {
                    let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                    let value = BoundVariableExpression(nil, method.Parameters[0])
                    let nilValue = BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                    let isAbsent = BoundBinaryExpression(
                        nil,
                        value,
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, value.Type, TypeSymbol.Null)!!,
                        nilValue
                    )
                    statements.Add(
                        BoundIfStatement(
                            nil,
                            isAbsent,
                            if method == operations.Present {
                                InvalidBoundary("A required native protocol value is absent")
                            } else {
                                cast[BoundStatement](
                                    BoundReturnStatement(nil, BoundConversionExpression(nil, method.Type, nilValue))
                                )
                            },
                            nil
                        )
                    )
                    for entry in registry.ProtocolEntries.Where(
                        (item NativeProtocolEntryPlan) -> item.Protocols.Contains(operations.Protocol)
                    ) {
                        let selected = LocalVariableSymbol("<>entry", isReadOnly: true, entry.Entry)
                        let pattern = BoundTypePattern(nil, value.Type, entry.Entry, selected)
                        let test = BoundIsExpression(nil, value, pattern)
                        let result = if method != operations.Payload {
                            cast[BoundExpression](BoundConversionExpression(nil, method.Type, value))
                        } else {
                            BoundConversionExpression(
                                nil,
                                method.Type,
                                BoundUserInstanceCallExpression(
                                    nil,
                                    BoundVariableExpression(nil, selected),
                                    entry.Recover,
                                    ImmutableArray[BoundExpression].Empty,
                                    entry.SourceType
                                )
                            )
                        }
                        statements.Add(BoundIfStatement(nil, test, BoundReturnStatement(nil, result), nil))
                    }
                    for entry in registry.ImportedProtocolEntries.Where(
                        (item ImportedNativeProtocolEntry) -> item.Decisions.TryGetValue(
                            operations.Protocol,
                            out var decision
                        ) &&
                            decision.Positive
                    ) {
                        let decision = entry.Decisions[operations.Protocol]
                        let test = BoundClrStaticCallExpression(
                            nil,
                            decision.Matches!!,
                            TypeSymbol.Bool,
                            ImmutableArray.Create[BoundExpression](value)
                        )
                        let result = if method != operations.Payload {
                            cast[BoundExpression](BoundConversionExpression(nil, method.Type, value))
                        } else {
                            BoundConversionExpression(
                                nil,
                                method.Type,
                                BoundClrStaticCallExpression(
                                    nil,
                                    decision.Recover!!,
                                    entry.SourceType,
                                    ImmutableArray.Create[BoundExpression](
                                        BoundConversionExpression(nil, operations.Protocol, value)
                                    )
                                )
                            )
                        }
                        statements.Add(BoundIfStatement(nil, test, BoundReturnStatement(nil, result), nil))
                    }
                    statements.Add(InvalidBoundary("Invalid or unknown native protocol evidence"))
                    registry.MethodBodies[method] = Lowerer.Lower(BoundBlockStatement(nil, statements.ToImmutable()))
                }
            }
        }

        internal func InvalidBoundary(message string) BoundStatement {
            let exceptionType = typeof(InvalidOperationException)
            let constructor = exceptionType.GetConstructor([]Type{typeof(string)})!!
            return BoundThrowStatement(
                nil,
                BoundClrConstructorCallExpression(
                    nil,
                    exceptionType,
                    constructor,
                    ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, message)),
                    TypeSymbol.FromClrTypeWithoutNullability(exceptionType, NullabilityFreeReason.CompilerProduced)
                )
            )
        }
    }
}
