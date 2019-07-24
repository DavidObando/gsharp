// <copyright file="ILOpCodeExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.CodeGen
{
    using System.Diagnostics;
    using System.Reflection.Metadata;

    /// <summary>
    /// Extensions for ILOpCode.
    /// </summary>
    public static partial class ILOpCodeExtensions
    {
        /// <summary>
        /// Gets the byte size of the ILOpcode.
        /// </summary>
        /// <param name="opcode">The ILOpCode.</param>
        /// <returns>The amount of bytes it occupies.</returns>
        public static int Size(this ILOpCode opcode)
        {
            int code = (int)opcode;
            if (code <= 0xff)
            {
                Debug.Assert(code < 0xf0, "Invalid code.");
                return 1;
            }
            else
            {
                Debug.Assert((code & 0xff00) == 0xfe00, "Invalid code.");
                return 2;
            }
        }
    }
}
