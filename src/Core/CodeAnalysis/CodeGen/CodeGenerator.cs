// <copyright file="CodeGenerator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.CodeGen
{
    using System.Diagnostics;
    using System.Reflection.Metadata;

    /// <summary>
    /// Code generator to MSIL.
    /// </summary>
    public sealed class CodeGenerator
    {
        private void WriteOpCode(BlobBuilder writer, ILOpCode code)
        {
            var size = code.Size();
            if (size == 1)
            {
                writer.WriteByte((byte)code);
            }
            else
            {
                // IL opcodes that occupy two bytes are written to
                // the byte stream with the high-order byte first,
                // in contrast to the little-endian format of the
                // numeric arguments and tokens.
                Debug.Assert(size == 2, "Expected a code size of 2.");
                writer.WriteByte((byte)((ushort)code >> 8));
                writer.WriteByte((byte)((ushort)code & 0xff));
            }
        }
    }
}
