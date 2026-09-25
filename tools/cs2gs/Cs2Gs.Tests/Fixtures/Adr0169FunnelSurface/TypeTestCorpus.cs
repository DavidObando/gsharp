// <copyright file="TypeTestCorpus.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Binding
{
    public class TypeSymbol
    {
        public int Rank { get; set; }
    }

    public class NullableTypeSymbol : TypeSymbol
    {
    }

    public class PlatformTypeSymbol : TypeSymbol
    {
    }

    public class Consumer
    {
        // Reported: a plain type test.
        public bool Plain(TypeSymbol type) => type is NullableTypeSymbol;

        // Reported: a declaration pattern.
        public int Declared(TypeSymbol type)
        {
            if (type is NullableTypeSymbol nullable)
            {
                return nullable.Rank;
            }

            return 0;
        }

        // Reported: a type pattern in a switch arm.
        public int Switched(TypeSymbol type)
        {
            switch (type)
            {
                case NullableTypeSymbol:
                    return 1;
                default:
                    return 0;
            }
        }

        // Reported: typeof.
        public Type Named() => typeof(NullableTypeSymbol);

        // Not reported: another type.
        public bool Other(TypeSymbol type) => type is PlatformTypeSymbol;

        // Reported: an imported property read.
        public int Measured(string text) => text.Length;

        // Not reported, and never handed to the property rule: an imported
        // field read.
        public string Blank() => string.Empty;
    }
}
