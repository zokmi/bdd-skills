using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

internal static class MaskRectangles
{
    public sealed class Rule
    {
        public int[] rect { get; set; }
        public string color { get; set; }
    }

    public sealed class Job
    {
        public string input { get; set; }
        public string output { get; set; }
        public Rule[] rules { get; set; }
    }

    private static ImageFormat Format(string file)
    {
        switch (Path.GetExtension(file).ToLowerInvariant())
        {
            case ".jpg": case ".jpeg": return ImageFormat.Jpeg;
            case ".gif": return ImageFormat.Gif;
            case ".bmp": return ImageFormat.Bmp;
            case ".png": return ImageFormat.Png;
            default: throw new InvalidDataException("Unsupported rectangle masking format: " + Path.GetExtension(file));
        }
    }

    private static void Render(Job job)
    {
        ImageFormat format = Format(job.input);
        using (var original = Image.FromFile(job.input))
        using (var canvas = new Bitmap(original.Width, original.Height, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(canvas))
            {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.DrawImageUnscaled(original, 0, 0);
                foreach (Rule rule in job.rules)
                {
                    int x = Math.Max(0, rule.rect[0]), y = Math.Max(0, rule.rect[1]);
                    int right = Math.Min(canvas.Width, rule.rect[2]), bottom = Math.Min(canvas.Height, rule.rect[3]);
                    if (right <= x || bottom <= y) throw new InvalidDataException("Mask rectangle covers no pixels: " + job.input);
                    Color color = ColorTranslator.FromHtml(rule.color);
                    if (color.A != 255) throw new InvalidDataException("Rectangle masks require an opaque color.");
                    using (var brush = new SolidBrush(color))
                        graphics.FillRectangle(brush, x, y, right - x, bottom - y);
                }
            }
            using (var output = new FileStream(job.output, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                canvas.Save(output, format);
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            var serializer = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
            foreach (Job job in serializer.Deserialize<List<Job>>(File.ReadAllText(args[0], Encoding.UTF8))) Render(job);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
