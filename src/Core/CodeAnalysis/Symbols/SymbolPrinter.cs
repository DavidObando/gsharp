// <copyright file="SymbolPrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    using System;
    using System.IO;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.IO;

    /// <summary>
    /// Symbol printer.
    /// </summary>
    public static class SymbolPrinter
    {
        /// <summary>
        /// Writes a symbol to the specified writer.
        /// </summary>
        /// <param name="symbol">The symbol.</param>
        /// <param name="writer">The writer.</param>
        public static void WriteTo(Symbol symbol, TextWriter writer)
        {
            switch (symbol.Kind)
            {
                case SymbolKind.Function:
                    WriteFunctionTo((FunctionSymbol)symbol, writer);
                    break;
                case SymbolKind.GlobalVariable:
                    WriteGlobalVariableTo((GlobalVariableSymbol)symbol, writer);
                    break;
                case SymbolKind.LocalVariable:
                    WriteLocalVariableTo((LocalVariableSymbol)symbol, writer);
                    break;
                case SymbolKind.Parameter:
                    WriteParameterTo((ParameterSymbol)symbol, writer);
                    break;
                case SymbolKind.Type:
                    WriteTypeTo((TypeSymbol)symbol, writer);
                    break;
                case SymbolKind.Package:
                    WritePackageTo((PackageSymbol)symbol, writer);
                    break;
                case SymbolKind.Import:
                    WriteImportTo((ImportSymbol)symbol, writer);
                    break;
                default:
                    throw new Exception($"Unexpected symbol: {symbol.Kind}");
            }
        }

        private static void WriteFunctionTo(FunctionSymbol symbol, TextWriter writer)
        {
            writer.WriteKeyword(SyntaxKind.FuncKeyword);
            writer.WriteSpace();
            writer.WriteIdentifier(symbol.Name);
            writer.WritePunctuation(SyntaxKind.OpenParenthesisToken);

            for (int i = 0; i < symbol.Parameters.Length; i++)
            {
                if (i > 0)
                {
                    writer.WritePunctuation(SyntaxKind.CommaToken);
                    writer.WriteSpace();
                }

                symbol.Parameters[i].WriteTo(writer);
            }

            writer.WritePunctuation(SyntaxKind.CloseParenthesisToken);
            if (symbol.Type != null)
            {
                writer.WriteSpace();
                writer.WriteIdentifier(symbol.Type.Name);
            }
        }

        private static void WriteGlobalVariableTo(GlobalVariableSymbol symbol, TextWriter writer)
        {
            writer.WriteKeyword(symbol.IsReadOnly ? SyntaxKind.ConstKeyword : SyntaxKind.VarKeyword);
            writer.WriteSpace();
            writer.WriteIdentifier(symbol.Name);
            if (symbol.Type != null)
            {
                writer.WriteSpace();
                symbol.Type.WriteTo(writer);
            }
        }

        private static void WriteLocalVariableTo(LocalVariableSymbol symbol, TextWriter writer)
        {
            writer.WriteKeyword(symbol.IsReadOnly ? SyntaxKind.ConstKeyword : SyntaxKind.VarKeyword);
            writer.WriteSpace();
            writer.WriteIdentifier(symbol.Name);

            if (symbol.Type != null)
            {
                writer.WriteSpace();
                symbol.Type.WriteTo(writer);
            }
        }

        private static void WriteParameterTo(ParameterSymbol symbol, TextWriter writer)
        {
            writer.WriteIdentifier(symbol.Name);
            if (symbol.Type != null)
            {
                writer.WriteSpace();
                symbol.Type.WriteTo(writer);
            }
        }

        private static void WriteTypeTo(TypeSymbol symbol, TextWriter writer)
        {
            writer.WriteIdentifier(symbol.Name);
        }

        private static void WritePackageTo(PackageSymbol symbol, TextWriter writer)
        {
            writer.WriteKeyword(SyntaxKind.PackageKeyword);
            writer.WriteSpace();
            writer.WriteIdentifier(symbol.Name);
        }

        private static void WriteImportTo(ImportSymbol symbol, TextWriter writer)
        {
            writer.WriteKeyword(SyntaxKind.ImportKeyword);
            writer.WriteSpace();
            writer.WriteIdentifier(symbol.Name);
        }
    }
}
