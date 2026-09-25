// <copyright file="MethodBodyEmitter.ManagedReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using System.Reflection.Metadata;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

internal sealed partial class MethodBodyEmitter
{
    private void EmitManagedFieldKey(BoundManagedFieldKeyExpression node)
    {
        this.EmitExpression(node.Parent);
        EntityHandle token;
        TypeSymbol declaringType;
        switch (node.Field)
        {
            case BoundFieldAccessExpression field:
                var container = Invariant.Required(
                    ResolveFieldReferenceContainer(field.StructType, field.Receiver?.Type as StructSymbol, field.Field),
                    "persistent source fields have a declaring class or struct");
                token = this.outer.userTokens.ResolveFieldToken(container, field.Field);
                declaringType = container;
                break;
            case BoundClrPropertyAccessExpression { Member: FieldInfo field } access:
                token = access.StaticContainerType != null
                    ? this.outer.memberRefs.GetFieldReference(field, access.StaticContainerType)
                    : this.outer.memberRefs.GetFieldReference(field);
                declaringType = access.StaticContainerType
                    ?? TypeSymbol.FromClrTypeWithoutNullability(Invariant.Required(field.DeclaringType, "instance fields have a declaring type"), NullabilityFreeReason.TypeStructure);
                break;
            default:
                throw new InvalidOperationException("Persistent field identity requires a resolved instance field.");
        }

        this.il.OpCode(ILOpCode.Ldtoken);
        this.il.Token(token);
        this.il.OpCode(ILOpCode.Ldtoken);
        this.il.Token(this.outer.memberRefs.GetTypeOfToken(declaringType));
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(
            Invariant.Required(
                Invariant.Required(node.Type.ClrType, "location keys have a runtime type").GetMethod("Field"),
                "the compiler-facing runtime key exposes Field")));
    }
}
