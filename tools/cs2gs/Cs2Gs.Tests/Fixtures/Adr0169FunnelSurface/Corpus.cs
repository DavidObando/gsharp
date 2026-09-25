// <copyright file="Corpus.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Binding
{
    [AttributeUsage(AttributeTargets.Method | AttributeTargets.Property)]
    public sealed class NullabilityFunnelAttribute : Attribute
    {
    }

    public enum NullabilityFreeReason
    {
        TypeLiteral,
        TypeStructure,
    }

    public class TypeSymbol
    {
        [NullabilityFunnel]
        public static TypeSymbol FromClrType(Type type) => new TypeSymbol();

        [NullabilityFunnel]
        public static TypeSymbol FromClrTypeWithoutNullability(Type type, NullabilityFreeReason reason) => FromClrType(type);
    }

    public class NullableTypeSymbol : TypeSymbol
    {
        public static TypeSymbol Get(TypeSymbol underlying) => underlying;
    }

    public class Consumer
    {
        // Reported: a door outside the funnel.
        public TypeSymbol Door(Type type) => TypeSymbol.FromClrType(type);

        // Not reported: the door inside a funnel member, including in a lambda.
        [NullabilityFunnel]
        public TypeSymbol Funnel(Type type)
        {
            Func<Type, TypeSymbol> read = t => TypeSymbol.FromClrType(t);
            return read(type);
        }

        // Reported: a door in a lambda, outside the funnel. The lambda is
        // part of the member's operation block.
        public Func<Type, TypeSymbol> InLambda() => t => TypeSymbol.FromClrType(t);

        // Reported: a door in a field initializer, which is an operation
        // block of its own, owned by the field.
        public readonly TypeSymbol Initialized = TypeSymbol.FromClrType(typeof(string));

        // Reported: a wrapper factory inside a funnel member.
        [NullabilityFunnel]
        public TypeSymbol Wrap(Type type) => NullableTypeSymbol.Get(TypeSymbol.FromClrType(type));

        // Reported: the escape hatch on a signature accessor.
        public TypeSymbol Accessor(MethodInfo method)
            => TypeSymbol.FromClrTypeWithoutNullability(method.ReturnType, NullabilityFreeReason.TypeStructure);

        // Reported: through a declared local.
        public TypeSymbol ViaLocal(PropertyInfo property)
        {
            var type = property.PropertyType;
            return TypeSymbol.FromClrTypeWithoutNullability(type, NullabilityFreeReason.TypeStructure);
        }

        // Reported: through an assignment.
        public TypeSymbol ViaAssignment(FieldInfo field)
        {
            Type type = typeof(object);
            type = field.FieldType;
            return TypeSymbol.FromClrTypeWithoutNullability(type, NullabilityFreeReason.TypeStructure);
        }

        // Reported: through a foreach collection.
        public TypeSymbol ViaLoop(MethodInfo method)
        {
            var result = TypeSymbol.FromClrTypeWithoutNullability(typeof(void), NullabilityFreeReason.TypeLiteral);
            foreach (var argument in method.ReturnType.GetGenericArguments())
            {
                result = TypeSymbol.FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure);
            }

            return result;
        }

        // Reported: through an `out var` producer.
        public TypeSymbol ViaOut(FieldInfo field)
        {
            Split(field.FieldType, out var fromOut);
            return TypeSymbol.FromClrTypeWithoutNullability(fromOut, NullabilityFreeReason.TypeStructure);
        }

        // Not reported: a type literal.
        public TypeSymbol Literal() => TypeSymbol.FromClrTypeWithoutNullability(typeof(int), NullabilityFreeReason.TypeLiteral);

        // Reported: a door as a method group.
        public Func<Type, TypeSymbol> Group() => TypeSymbol.FromClrType;

        // Reported: a door in an unattributed property.
        public TypeSymbol Plain => TypeSymbol.FromClrType(typeof(string));

        // Not reported: a door in an attributed property's getter.
        [NullabilityFunnel]
        public TypeSymbol Funneled => TypeSymbol.FromClrType(typeof(string));

        private static void Split(Type type, out Type result) => result = type;
    }
}
