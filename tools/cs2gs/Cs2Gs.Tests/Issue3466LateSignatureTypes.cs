// <copyright file="Issue3466LateSignatureTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Models
{
    public sealed class TextStringBuilder
    {
    }
}

namespace Signatures
{
    public static class OptionalSignatureMethod
    {
        public static int Read(
            System.Text.StringBuilder first = null,
            Models.TextStringBuilder second = null,
            params List<int> values) =>
            (first?.Length ?? 1) + (second == null ? 2 : 0) + values.Count;
    }

    public sealed class OptionalSignatureConstructor
    {
        public OptionalSignatureConstructor(
            System.Text.StringBuilder first = null,
            Models.TextStringBuilder second = null)
        {
            this.Value = (first?.Length ?? 1) + (second == null ? 2 : 0);
        }

        public int Value { get; }

        public int Marker { get; set; }
    }
}
