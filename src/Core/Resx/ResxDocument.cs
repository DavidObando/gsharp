// <copyright file="ResxDocument.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Xml.Linq;

namespace GSharp.Core.Resx;

/// <summary>
/// A parsed <c>.resx</c> document (ADR-0142): the ordered set of real
/// resource entries, with Visual Studio's design-time-only metadata rows
/// (<c>&lt;data name="&gt;&gt;..."&gt;</c>, produced by the WinForms/WPF
/// designer) and <c>&lt;resheader&gt;</c> rows filtered out.
/// </summary>
public sealed class ResxDocument
{
    private ResxDocument(IReadOnlyList<ResxEntry> entries)
    {
        this.Entries = entries;
    }

    /// <summary>Gets the resource entries, in document order.</summary>
    public IReadOnlyList<ResxEntry> Entries { get; }

    /// <summary>
    /// Parses resx XML text into a <see cref="ResxDocument"/>.
    /// </summary>
    /// <param name="xml">The full text content of a <c>.resx</c> file.</param>
    /// <returns>The parsed document.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="xml"/> is <see langword="null"/>.</exception>
    public static ResxDocument Parse(string xml)
    {
        if (xml is null)
        {
            throw new ArgumentNullException(nameof(xml));
        }

        var root = XDocument.Parse(xml).Root;
        var entries = new List<ResxEntry>();
        if (root is not null)
        {
            foreach (var data in root.Elements("data"))
            {
                var name = (string)data.Attribute("name");
                if (string.IsNullOrEmpty(name))
                {
                    continue;
                }

                // Design-time-only metadata rows (e.g. ">>$this.Name",
                // ">>treeView1.Nodes") record designer state, not resources —
                // real ResX code generators skip them and so do we.
                if (name.StartsWith(">>", StringComparison.Ordinal))
                {
                    continue;
                }

                var value = data.Element("value")?.Value ?? string.Empty;
                var comment = data.Element("comment")?.Value ?? string.Empty;
                var typeName = (string)data.Attribute("type") ?? string.Empty;
                var mimeType = (string)data.Attribute("mimetype") ?? string.Empty;
                entries.Add(new ResxEntry(name, value, comment, typeName, mimeType));
            }
        }

        return new ResxDocument(entries.ToImmutableArray());
    }

    /// <summary>Parses resx XML text loaded from disk.</summary>
    /// <param name="path">The path to a <c>.resx</c> file.</param>
    /// <returns>The parsed document.</returns>
    public static ResxDocument ParseFile(string path)
    {
        return Parse(System.IO.File.ReadAllText(path));
    }
}
