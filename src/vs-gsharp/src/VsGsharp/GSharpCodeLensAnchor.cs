namespace GSharp.VisualStudio;

internal static class GSharpCodeLensAnchor
{
    internal static int Find(string line, int fallback)
    {
        for (int i = 0; i < line.Length; i++)
        {
            if (!char.IsWhiteSpace(line[i]))
            {
                return i;
            }
        }

        return System.Math.Min(System.Math.Max(fallback, 0), line.Length);
    }
}
