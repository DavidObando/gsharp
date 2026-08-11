// <copyright file="DocumentationFileEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Xml;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Documentation;

internal static class DocumentationFileEmitter
{
    public static void Emit(Stream xmlStream, string? assemblyName, BoundProgram program)
    {
        ArgumentNullException.ThrowIfNull(xmlStream);
        ArgumentNullException.ThrowIfNull(program);

        var members = CollectMembers(program)
            .OrderBy(entry => entry.DocId, StringComparer.Ordinal)
            .ToArray();

        using var streamWriter = new StreamWriter(xmlStream, new UTF8Encoding(false), 1024, leaveOpen: true)
        {
            NewLine = "\n",
        };

        streamWriter.WriteLine("<?xml version=\"1.0\"?>");

        var settings = new XmlWriterSettings
        {
            CloseOutput = false,
            Indent = true,
            IndentChars = "    ",
            NewLineChars = "\n",
            OmitXmlDeclaration = true,
        };

        using var writer = XmlWriter.Create(streamWriter, settings);
        writer.WriteStartElement("doc");

        writer.WriteStartElement("assembly");
        writer.WriteElementString("name", assemblyName ?? string.Empty);
        writer.WriteEndElement();

        writer.WriteStartElement("members");
        foreach (var member in members)
        {
            writer.WriteStartElement("member");
            writer.WriteAttributeString("name", member.DocId);
            if (!string.IsNullOrEmpty(member.XmlFragment))
            {
                writer.WriteRaw("\n");
                writer.WriteRaw(IndentFragment(member.XmlFragment, "            "));
                writer.WriteRaw("\n        ");
            }

            writer.WriteEndElement();
        }

        writer.WriteEndElement();
        writer.WriteEndElement();
        writer.Flush();
        streamWriter.Flush();
    }

    private static IEnumerable<MemberDocumentation> CollectMembers(BoundProgram program)
    {
        var members = new List<MemberDocumentation>();

        foreach (var type in program.Structs)
        {
            AddIfDocumented(members, type);

            foreach (var field in type.Fields)
            {
                AddIfDocumented(members, field, type);
            }

            foreach (var property in type.Properties)
            {
                AddIfDocumented(members, property, type);
            }

            foreach (var @event in type.Events)
            {
                AddIfDocumented(members, @event, type);
            }

            foreach (var method in type.Methods)
            {
                AddIfDocumented(members, method);
            }

            foreach (var field in type.StaticFields)
            {
                AddIfDocumented(members, field, type);
            }

            foreach (var field in type.ConstFields)
            {
                AddIfDocumented(members, field, type);
            }

            foreach (var property in type.StaticProperties)
            {
                AddIfDocumented(members, property, type);
            }

            foreach (var @event in type.StaticEvents)
            {
                AddIfDocumented(members, @event, type);
            }

            foreach (var method in type.StaticMethods)
            {
                AddIfDocumented(members, method);
            }

            foreach (var constructor in type.ExplicitConstructors)
            {
                AddIfDocumented(members, constructor.Function);
            }
        }

        foreach (var type in program.Interfaces)
        {
            AddIfDocumented(members, type);

            foreach (var method in type.Methods)
            {
                AddIfDocumented(members, method);
            }

            foreach (var method in type.StaticMethods)
            {
                AddIfDocumented(members, method);
            }

            foreach (var property in type.Properties)
            {
                AddIfDocumented(members, property, type);
            }

            foreach (var @event in type.Events)
            {
                AddIfDocumented(members, @event, type);
            }

            foreach (var field in type.StaticFields)
            {
                AddIfDocumented(members, field, type);
            }

            foreach (var field in type.ConstFields)
            {
                AddIfDocumented(members, field, type);
            }
        }

        foreach (var type in program.Enums)
        {
            AddIfDocumented(members, type);
            foreach (var member in type.Members)
            {
                AddIfDocumented(members, member);
            }
        }

        foreach (var type in program.Delegates)
        {
            AddIfDocumented(members, type);
        }

        foreach (var function in program.Functions.Keys)
        {
            if (function.ReceiverType is null && function.StaticOwnerType is null)
            {
                AddIfDocumented(members, function);
            }
        }

        return members;
    }

    private static void AddIfDocumented(List<MemberDocumentation> members, Symbol symbol)
    {
        var documentation = symbol.GetDocumentation();
        if (documentation is null)
        {
            return;
        }

        var docId = SymbolDocumentationIdProvider.GetDocumentationId(symbol);
        if (docId is null)
        {
            return;
        }

        members.Add(new MemberDocumentation(docId, DocumentationXmlWriter.WriteXmlFragment(documentation)));
    }

    private static void AddIfDocumented(List<MemberDocumentation> members, Symbol symbol, TypeSymbol ownerType)
    {
        var documentation = symbol.GetDocumentation();
        if (documentation is null)
        {
            return;
        }

        var docId = SymbolDocumentationIdProvider.GetDocumentationId(symbol, ownerType);
        if (docId is null)
        {
            return;
        }

        members.Add(new MemberDocumentation(docId, DocumentationXmlWriter.WriteXmlFragment(documentation)));
    }

    private static string IndentFragment(string fragment, string indentation)
    {
        var normalized = fragment.Replace("\r\n", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n');
        var builder = new StringBuilder();
        for (var i = 0; i < lines.Length; i++)
        {
            if (i > 0)
            {
                builder.Append('\n');
            }

            if (lines[i].Length > 0)
            {
                builder.Append(indentation);
            }

            builder.Append(lines[i]);
        }

        return builder.ToString();
    }

    private sealed record MemberDocumentation(string DocId, string XmlFragment);
}
