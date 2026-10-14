// <copyright file="ManagedReferenceLowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Forms typed location helpers after whole-root capture boxing, before any
/// borrowed address is emitted or suspension state is planned.
internal class ManagedReferenceLowerer : BoundTreeRewriter {
    private let references ReferenceResolver
    private let helpers List[StructSymbol] = List[StructSymbol]()
    private let methods Dictionary[FunctionSymbol, BoundBlockStatement] = Dictionary[
        FunctionSymbol,
        BoundBlockStatement
    ]()
    private var function FunctionSymbol?
    private var counter int32

    private init(references ReferenceResolver) {
        this.references = references
    }

    protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
        let body = cast[BoundBlockStatement](this.RewriteStatement(node.Body))
        return if body == node.Body {
            node
        } else {
            BoundFunctionLiteralExpression(node.Syntax, node.Function, node.FunctionType, body, node.CapturedVariables)
        }
    }

    protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
        let literal = cast[BoundFunctionLiteralExpression](this.RewriteFunctionLiteralExpression(node.Literal))
        return if literal == node.Literal {
            node
        } else {
            BoundLocalFunctionDeclaration(node.Syntax, literal)
        }
    }

    protected override func RewriteManagedReferenceExpression(
        node BoundManagedReferenceExpression
    ) BoundExpression -> this.Capture(this.RewriteExpression(node.Location), node.Type, node.IsReadOnly)

    private func Capture(location BoundExpression, type TypeSymbol, readOnly bool) BoundExpression {
        switch location {
            case block is BoundBlockExpression {
                return BoundBlockExpression(
                    block.Syntax,
                    block.Statements,
                    this.Capture(block.Expression, type, readOnly)
                )
            }
            case dereference is BoundDereferenceExpression {
                return this.CapturePointer(dereference.Operand, type, readOnly)
            }
            case index is BoundIndexExpression {
                let factoryName = if index.Index.Type == TypeSymbol.NInt {
                    "FromArrayNative"
                } else {
                    "FromArray"
                }
                let arrayFactory = RequiredClr(type).GetMethods().Single((m MethodInfo) -> m.Name == factoryName)
                return BoundClrStaticCallExpression(
                    location.Syntax,
                    arrayFactory,
                    type,
                    ImmutableArray.Create(index.Target, index.Index)
                )
            }
            case BoundFieldAccessExpression{Receiver: {} receiver} {
                return this.CaptureField(location, receiver, type, readOnly)
            }
            case BoundClrPropertyAccessExpression{Receiver: {} receiver, Member: FieldInfo} {
                return this.CaptureField(location, receiver, type, readOnly)
            }
            default {
                throw InvalidOperationException("Unplanned persistent location: ${location.Kind}.")
            }
        }
    }

    private func CapturePointer(pointer BoundExpression, type TypeSymbol, readOnly bool) BoundExpression {
        switch pointer {
            case block is BoundBlockExpression {
                return BoundBlockExpression(
                    block.Syntax,
                    block.Statements,
                    this.CapturePointer(block.Expression, type, readOnly)
                )
            }
            case address is BoundAddressOfExpression {
                return this.Capture(address.Operand, type, readOnly)
            }
            case index is BoundClrIndexExpression {
                let name = if readOnly {
                    "GetReadOnlyManagedReference"
                } else {
                    "GetManagedReference"
                }
                let runtimeType = Invariant.Required(
                    index.Indexer.DeclaringType,
                    "a CLR indexer has a runtime declaring type",
                    expression: "index.Indexer.DeclaringType"
                )
                let method = runtimeType.GetMethods().Single(
                    (m MethodInfo) -> m.Name == name &&
                        ParametersMatch(m.GetParameters(), index.Indexer.GetIndexParameters())
                )
                return BoundImportedInstanceCallExpression(pointer.Syntax, index.Target, method, type, index.Arguments)
            }
            case call is BoundImportedInstanceCallExpression when ManagedReferenceOrigins.IsHandleBorrow(call) {
                ManagedReferenceTypes.TryGetElement(call.Receiver.Type, out _, out var sourceReadOnly)
                return if readOnly && !sourceReadOnly {
                    Call(call.Receiver, "AsReadOnly", type)
                } else {
                    call.Receiver
                }
            }
            default {
                throw InvalidOperationException("Unplanned persistent pointer origin: ${pointer.Kind}.")
            }
        }
    }

    private func CaptureField(
        field BoundExpression,
        receiver BoundExpression,
        type TypeSymbol,
        readOnly bool
    ) BoundExpression {
        let objectRoot = GSharp.Core.CodeAnalysis.Binding.Binder.IsReferenceTypeForConstraint(receiver.Type)
        let selected = if objectRoot {
            receiver
        } else {
            this.Capture(receiver, this.HandleType(receiver.Type, readOnly), readOnly)
        }
        let selectedLocal = LocalVariableSymbol("<>locationOwner" + this.counter++.ToString(), false, selected.Type)
        let selectedRead = BoundVariableExpression(nil, selectedLocal)
        let keyType = TypeSymbol.FromClrTypeWithoutNullability(
            this.RequiredRuntimeType("Gsharp.Values.ManagedLocationKey"),
            NullabilityFreeReason.TypeLiteral
        )
        let parentKey = if objectRoot {
            cast[BoundExpression](
                BoundClrStaticCallExpression(
                    nil,
                    Invariant.Required(
                        RequiredClr(keyType).GetMethod("Object"),
                        "the location runtime supplies Object",
                        expression: "RequiredClr(keyType).GetMethod(\"Object\")"
                    ),
                    keyType,
                    ImmutableArray.Create[BoundExpression](
                        BoundConversionExpression(nil, TypeSymbol.Object, selectedRead)
                    )
                )
            )
        } else {
            Call(selectedRead, "GetLocation", keyType)
        }
        let key = BoundManagedFieldKeyExpression(parentKey, field)
        let ownerField = FieldSymbol("Owner", selected.Type, Accessibility.Public)
        let keyField = FieldSymbol("Location", keyType, Accessibility.Public)
        let helper = StructSymbol(
            "<>__ManagedLocation" + this.counter++.ToString(),
            ImmutableArray.Create(ownerField, keyField),
            Accessibility.Internal,
            declaration: nil,
            packageName: this.function?.Package?.Name ?? string.Empty,
            isData: false,
            isInline: false,
            isClass: true
        )
        helper.SetImportedBaseType(type)
        let enclosing = this
            .function
            ?.ReceiverType ??
            this
            .function
            ?.StaticOwnerType ??
            this
            .function
            ?.LexicalEnclosingType
        let enclosingDefinition TypeSymbol? = switch enclosing {
            case aggregate is StructSymbol: cast[TypeSymbol](aggregate.Definition)
            case interfaceType is InterfaceSymbol: cast[TypeSymbol](interfaceType.Definition)
            default: nil
        }
        let borrow = FunctionSymbol(
            "Borrow",
            ImmutableArray[ParameterSymbol].Empty,
            field.Type,
            declaration: nil,
            this.function?.Package,
            Accessibility.Public,
            helper,
            isOpen: false,
            isOverride: true
        ){
            ReturnRefKind = if readOnly {
                RefKind.RefReadOnly
            } else {
                RefKind.Ref
            },
            ExternalOverriddenMethod = OverrideBase(type).GetMethods().Single((m MethodInfo) -> m.Name == "Borrow"),
            ExternalOverrideContainingType = type
        }
        let helperThis = BoundVariableExpression(
            nil,
            Invariant.Required(
                borrow.ThisParameter,
                "the generated Borrow is an instance method",
                expression: "borrow.ThisParameter"
            )
        )
        let retainedOwner = BoundFieldAccessExpression(nil, helperThis, helper, ownerField)
        let fieldReceiver = if objectRoot {
            cast[BoundExpression](retainedOwner)
        } else {
            cast[BoundExpression](BoundDereferenceExpression(nil, ManagedReferenceTypes.Borrow(retainedOwner)))
        }
        let borrowedField BoundExpression = switch field {
            case source is BoundFieldAccessExpression: cast[BoundExpression](
                BoundFieldAccessExpression(nil, fieldReceiver, source.StructType, source.Field)
            )
            case source is BoundClrPropertyAccessExpression: cast[BoundExpression](
                BoundClrPropertyAccessExpression(
                    nil,
                    fieldReceiver,
                    source.Member,
                    source.Type,
                    source.StaticContainerType
                )
            )
            default: throw InvalidOperationException("Expected a resolved field.")
        }
        this.methods[borrow] = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundReturnStatement(
                    nil,
                    BoundAddressOfExpression(nil, borrowedField, unmanaged: false, isReadOnly: readOnly),
                    isRef: true
                )
            )
        )
        let identity = FunctionSymbol(
            "GetLocation",
            ImmutableArray[ParameterSymbol].Empty,
            keyType,
            declaration: nil,
            this.function?.Package,
            Accessibility.Public,
            helper,
            isOpen: false,
            isOverride: true
        ){
            ExternalOverriddenMethod = OverrideBase(type).GetMethods().Single(
                (m MethodInfo) -> m.Name == "GetLocation"
            ),
            ExternalOverrideContainingType = type
        }
        let identityThis = BoundVariableExpression(
            nil,
            Invariant.Required(
                identity.ThisParameter,
                "GetLocation is an instance method",
                expression: "identity.ThisParameter"
            )
        )
        this.methods[identity] = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundReturnStatement(nil, BoundFieldAccessExpression(nil, identityThis, helper, keyField))
            )
        )
        helper.SetMethods(ImmutableArray.Create(borrow, identity))
        this.helpers.Add(helper)
        var parameters = SynthesizedClosureReifier.CollectOrdered([]TypeSymbol{selected.Type, type})
        if (enclosingDefinition is StructSymbol or InterfaceSymbol) {
            let ownerTypeParameters = StructSymbol.CollectEnclosingTypeParameters(enclosingDefinition!!).AddRange(
                switch enclosingDefinition {
                    case aggregate is StructSymbol: aggregate.TypeParameters
                    case interfaceType is InterfaceSymbol: interfaceType.Definition!!.TypeParameters
                    default: ImmutableArray[TypeParameterSymbol].Empty
                }
            )
            if !ownerTypeParameters.IsDefaultOrEmpty {
                let seeded = ImmutableArray.CreateBuilder[TypeParameterSymbol](
                    ownerTypeParameters.Length + parameters.Length
                )
                seeded.AddRange(ownerTypeParameters)
                for parameter in parameters {
                    if !ownerTypeParameters.Contains(parameter) {
                        seeded.Add(parameter)
                    }
                }
                parameters = seeded.ToImmutable()
                helper.MarkCompleteReifiedTypeParameterVector()
            }
        }
        let construction = if parameters.IsDefaultOrEmpty {
            helper
        } else {
            SynthesizedClosureReifier.Reify(helper, parameters, this.references.MapClrTypeToReferences)
        }
        if (enclosingDefinition is StructSymbol or InterfaceSymbol) {
            helper.SetContainingType(enclosingDefinition!!)
        }
        let instance = BoundStructLiteralExpression(
            nil,
            construction,
            ImmutableArray.Create(
                BoundFieldInitializer(construction.Fields[0], selectedRead),
                BoundFieldInitializer(construction.Fields[1], key)
            )
        )
        return BoundBlockExpression(
            field.Syntax,
            ImmutableArray.Create[BoundStatement](BoundVariableDeclaration(nil, selectedLocal, selected)),
            BoundConversionExpression(nil, type, instance)
        )
    }

    private func HandleType(element TypeSymbol, readOnly bool) TypeSymbol {
        ManagedReferenceTypes.TryResolveDefinition(this.references, readOnly, out var definition)
        return ManagedReferenceTypes.Construct(
            Invariant.Required(
                definition,
                "binding established the compatible handle runtime",
                expression: "definition"
            ),
            element,
            this.references
        )
    }

    private func RequiredRuntimeType(name string) Type {
        this.references.TryResolveType(name, out var type)
        return Invariant.Required(
            type,
            "binding established the compatible managed-reference runtime",
            expression: "type"
        )
    }

    shared {
        internal func Lower(program BoundProgram, references ReferenceResolver) BoundProgram {
            let rewriter = ManagedReferenceLowerer(references)
            let functions = program.Functions.ToBuilder()
            // Issue #4663: deterministic order, never identity-hash order.
            for pair in BoundProgramOrder.Functions(program) {
                rewriter.function = pair.Key
                functions[pair.Key] = cast[BoundBlockStatement](rewriter.RewriteStatement(pair.Value))
            }
            let initializers = program.Initializers.ToBuilder()
            for pair in BoundProgramOrder.Initializers(program) {
                rewriter.function = pair.Value.Function
                initializers[pair.Key] = pair.Value.Rewrite(rewriter.RewriteExpression, rewriter.RewriteStatement)
            }
            for pair in rewriter.methods {
                functions[pair.Key] = pair.Value
            }
            let statement = if program.EntryPoint is {} entry && program.Functions.TryGetValue(entry, out var body) &&
                object.ReferenceEquals(body, program.Statement) {
                functions[entry]
            } else {
                program.Statement
            }
            return BoundProgram(
                program.EntryPointPackage,
                program.Packages,
                program.Diagnostics,
                functions.ToImmutable(),
                program.EntryPoint,
                statement,
                program.Structs.AddRange(rewriter.helpers),
                program.Interfaces,
                program.Enums,
                program.Globals,
                program.Delegates
            ){
                Initializers = initializers.ToImmutable(),
                Imports = program.Imports,
                FriendAssemblies = program.FriendAssemblies,
                AssemblyAttributes = program.AssemblyAttributes,
                ModuleAttributes = program.ModuleAttributes
            }
        }

        private func RequiredClr(type TypeSymbol) Type -> Invariant.Required(
            type.ClrType,
            "the compiler-facing runtime has a CLR type",
            expression: "type.ClrType"
        )

        private func OverrideBase(type TypeSymbol) Type -> if type is ImportedTypeSymbol{
            OpenDefinition: not nil,
            HasSubstitutableTypeArgument: true
        } imported {
            imported.OpenDefinition!!
        } else {
            RequiredClr(type)
        }

        private func Call(
            receiver BoundExpression,
            name string,
            type TypeSymbol
        ) BoundExpression -> BoundImportedInstanceCallExpression(
            nil,
            receiver,
            RequiredClr(receiver.Type).GetMethods().Single(
                (m MethodInfo) -> m.Name == name && m.GetParameters().Length == 0
            ),
            type,
            ImmutableArray[BoundExpression].Empty
        )

        private func ParametersMatch(left[]ParameterInfo, right[]ParameterInfo) bool -> left.Length == right.Length &&
            left
            .Zip(right).All(
            (pair(First ParameterInfo, Second ParameterInfo)) -> ClrTypeUtilities.AreSame(
                pair.First.ParameterType,
                pair.Second.ParameterType
            )
        )
    }
}
