// pi-status-window —— 程序入口
// Entry point: single-instance mutex + launch the floating window.
// C# 5 compatible (compiled with .NET Framework 4.x csc.exe).
using System;
using System.Threading;
using System.Windows.Forms;

namespace PiStatusWindow
{
    internal static class Program
    {
        private const string MutexName = "Global\\PiStatusWindow_SingleInstance";

        [STAThread]
        private static void Main()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    // Another instance is running — signal it and exit.
                    // (Simple approach: just exit. The running window stays.)
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                try
                {
                    Application.Run(new MainForm());
                }
                catch (Exception ex)
                {
                    MessageBox.Show("pi-status-window error:\n\n" + ex.Message,
                        "Pi Status Window", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }
    }
}
