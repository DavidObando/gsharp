// <copyright file="SymbolPrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.IO;

namespace GSharp.Core.CodeAnalysis.Symbols;

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
            case SymbolKind.EnumMember:
                WriteEnumMemberTo((EnumMemberSymbol)symbol, writer);
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
        if (symbol is NullableTypeSymbol nullable
            && TryWriteConstructedTypeTo(nullable.UnderlyingType, writer))
        {
            writer.Write('?');
            return;
        }

        if (!TryWriteConstructedTypeTo(symbol, writer))
        {
            writer.WriteIdentifier(symbol.Name);
        }
    }

    private static bool TryWriteConstructedTypeTo(TypeSymbol symbol, TextWriter writer)
    {
        switch (symbol)
        {
            case StructSymbol { TypeArguments.IsDefaultOrEmpty: false } aggregate:
                WriteConstructedTypeTo(aggregate.Definition.Name, aggregate.TypeArguments, writer);
                return true;
            case InterfaceSymbol { TypeArguments.IsDefaultOrEmpty: false } @interface:
                WriteConstructedTypeTo(@interface.Definition.Name, @interface.TypeArguments, writer);
                return true;
            case DelegateTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } @delegate:
                WriteConstructedTypeTo(@delegate.Definition.Name, @delegate.TypeArguments, writer);
                return true;
            case ImportedTypeSymbol imported:
                return TryWriteImportedConstructedTypeTo(imported, writer);
            default:
                return false;
        }
    }

    private static void WriteConstructedTypeTo(
        string name,
        ImmutableArray<TypeSymbol> typeArguments,
        TextWriter writer)
    {
        writer.WriteIdentifier(RemoveGenericArity(name));
        writer.Write('[');
        for (var i = 0; i < typeArguments.Length; i++)
        {
            if (i > 0)
            {
                writer.Write(", ");
            }

            WriteTypeTo(typeArguments[i], writer);
        }

        writer.Write(']');
    }

    private static bool TryWriteImportedConstructedTypeTo(ImportedTypeSymbol imported, TextWriter writer)
    {
        if (imported.OpenDefinition != null && !imported.TypeArguments.IsDefaultOrEmpty)
        {
            WriteConstructedTypeTo(
                imported.OpenDefinition.FullName ?? imported.OpenDefinition.Name,
                imported.TypeArguments,
                writer);
            return true;
        }

        var clrType = imported.ClrType;
        if (clrType == null || !clrType.IsGenericType || clrType.IsGenericTypeDefinition)
        {
            return false;
        }

        var definition = clrType.GetGenericTypeDefinition();
        var clrArguments = clrType.GetGenericArguments();
        var typeArguments = ImmutableArray.CreateBuilder<TypeSymbol>(clrArguments.Length);
        foreach (var argument in clrArguments)
        {
            typeArguments.Add(TypeSymbol.FromClrType(argument));
        }

        WriteConstructedTypeTo(
            definition.FullName ?? definition.Name,
            typeArguments.MoveToImmutable(),
            writer);
        return true;
    }

    private static string RemoveGenericArity(string name)
    {
        for (var tick = name.IndexOf('`'); tick >= 0; tick = name.IndexOf('`', tick))
        {
            var end = tick + 1;
            while (end < name.Length && char.IsDigit(name[end]))
            {
                end++;
            }

            name = name.Remove(tick, end - tick);
        }

        return name;
    }

    private static void WriteEnumMemberTo(EnumMemberSymbol symbol, TextWriter writer)
    {
        writer.WriteIdentifier(symbol.EnumType.Name);
        writer.WritePunctuation(SyntaxKind.DotToken);
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
