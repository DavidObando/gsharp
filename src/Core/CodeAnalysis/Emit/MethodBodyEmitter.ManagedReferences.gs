// <copyright file="MethodBodyEmitter.ManagedReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Reflection
import System.Reflection.Metadata

internal partial class MethodBodyEmitter {
    private func EmitManagedFieldKey(node BoundManagedFieldKeyExpression) {
        this.EmitExpression(node.Parent)
        var token EntityHandle
        var declaringType TypeSymbol
        switch node.Field {
            case field is BoundFieldAccessExpression {
                let container = Invariant.Required(
                    ResolveFieldReferenceContainer(field.StructType, field.Receiver?.Type as StructSymbol, field.Field),
                    "persistent source fields have a declaring class or struct",
                    expression: "ResolveFieldReferenceContainer(field.StructType, field.Receiver?.Type as StructSymbol, field.Field)"
                )
                token = this.outer.userTokens.ResolveFieldToken(container, field.Field)
                declaringType = container
            }
            case BoundClrPropertyAccessExpression{Member: FieldInfo field} access {
                token = if access.StaticContainerType != nil {
                    this.outer.memberRefs.GetFieldReference(field, access.StaticContainerType)
                } else {
                    this.outer.memberRefs.GetFieldReference(field)
                }
                declaringType = access.StaticContainerType ?? TypeSymbol.FromClrTypeWithoutNullability(
                    Invariant.Required(
                        field.DeclaringType,
                        "instance fields have a declaring type",
                        expression: "field.DeclaringType"
                    ),
                    NullabilityFreeReason.TypeStructure
                )
            }
            default {
                throw InvalidOperationException("Persistent field identity requires a resolved instance field.")
            }
        }
        this.il.OpCode(ILOpCode.Ldtoken)
        this.il.Token(token)
        this.il.OpCode(ILOpCode.Ldtoken)
        this.il.Token(this.outer.memberRefs.GetTypeOfToken(declaringType))
        this.il.OpCode(ILOpCode.Callvirt)
        this.il.Token(
            this
                .outer
                .memberRefs
                .GetMethodReference(
                Invariant.Required(
                    Invariant.Required(
                        node.Type.ClrType,
                        "location keys have a runtime type",
                        expression: "node.Type.ClrType"
                    )
                        .GetMethod("Field"),
                    "the compiler-facing runtime key exposes Field",
                    expression: "Invariant.Required(node.Type.ClrType, \"location keys have a runtime type\").GetMethod(\"Field\")"
                )
            )
        )
    }
}
