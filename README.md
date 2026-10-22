# XMUM AIHUB – AIT GPU Server 

**Website:** https://xmum-aihub.github.io/

## Rules and Tutorial on Remote Login, Module Loading, and Job Submission with Slurm



### Purpose of Use

This server is dedicated to training AI models and computational tasks related to your coursework or research in AI. Security testing, penetration testing, or unrelated tasks are strictly prohibited. Basic Linux skills are expected. 



### Server Usage Rules for Users

**Authorized Users Only:** Access to the server is granted only to authorized users for academic purposes.

**Use Secure SSH Login:** Always use secure SSH login with your username and password.

**Protect Credentials:** Do not share your login credentials with anyone. Unauthorized access is prohibited.

**No Personal Data:** Only store data relevant to your academic or research projects. Personal or sensitive data is prohibited.

**Backup Regularly:** Ensure important files are backed up. The server may undergo maintenance that could impact data availability.

**Data Security:** Do not attempt to access or interfere with other users' data or jobs.

**One GPU at Most:** Each job may request at most 1 GPU (`--gres=gpu:1`). The GPUs are shared, so do not request more.

**Report Issues:** Immediately report any security incidents or vulnerabilities to the server administrator.

**Respect Maintenance Schedules:** Regular maintenance times will be communicated. Backup before the maintenance & Log out during these times to avoid data loss.

**Academic Use Only:** The server is for educational and research purposes only. Commercial or personal use is prohibited.

**Follow University Policies:** Adhere to all university policies and guidelines related to computing resources.



### Consequences of Misuse

**Account Suspension:** Failure to follow these rules may result in temporary or permanent suspension of server access.

**Academic Discipline:** Misuse of resources may be reported and could lead to academic disciplinary action.



----------------------------------------------------------------------------------------------------------------



### Tutorial on Remote Login, Module Loading, and Job Submission with Slurm



### Prerequisites


- The SSH client is installed on your local machine.

- Access to a remote server with Slurm and module tools installed.

- A prepared job script (or familiarity with creating one).

- To Upload/Create/View/Modify Files, it is recommended to use FinalShell or FileZilla.



----------------------------------------------------------------------------------------------------------------


### Step 1: Login to the Remote Server


To Login via SSH:

1. Open a Terminal on your local machine.


2. Run the SSH Command:

   ssh -p port username@hostname

   - Replace `username` with your remote server username.

   - Replace `hostname` with the IP address or domain name of the server.

   - Replace `port` with the server's SSH port (use 22 if you weren't given one).

   Example:

		ssh -p 22 user123@cluster.example.com


3. Authenticate by entering your password if prompted. List of allowed commands will be displayed after login.


----------------------------------------------------------------------------------------------------------------


### Step 2: Access a Compute Node


**Required:** you must run this command before you continue to Step 3. Every step after this one is done on the compute node.

1. After logging in you are on the login node. Open a shell on a compute node:

		srun --pty bash -l

   - `--pty` connects the session to your terminal, and `bash -l` starts a login shell so commands like `module` work.

   - Your prompt changes to show the compute node's name. If the server is busy, wait until the shell opens.


2. When you have finished working, leave the compute node so its resources are freed for others:

		exit


----------------------------------------------------------------------------------------------------------------


### Step 3: Load Required Modules


Modules often access specific software or libraries on a shared server (currently, only Anaconda is installed with the latest Torch, TensorFlow). You can also install packages with pip and create your python environment with conda.


Listing and Loading Modules:

1. List Available Modules:

		module avail

   - This command displays all modules available for loading on the server.


2. Load a Module:

   module load modulename

   - Replace `modulename` with the desired module name.

   Example:

		module load anaconda


3. Verify Loaded Modules:

		module list

   - Shows the list of modules currently loaded in your session.


----------------------------------------------------------------------------------------------------------------


### Step 4: Prepare a Slurm Job Script


There are two ways to submit jobs to SLURM.


#### Method 1: Run a Python script interactively:

1. From terminal,
		
		srun --gres=gpu:1 --time=00:30:00 --mem=500M python my_script.py

   
	Information:
	- `--gres=gpu:1`: Specifies 1 GPU.
	
	- `--time=00:30:00`: Sets a 30-minute runtime limit.
	
	- `--mem=500M`: Allocates 500MB of memory.
	
	This will run `my_script.py` and display output directly in the terminal.


#### Method 2 : To submit a python script to Slurm, you need a job script with specific configurations and commands. Below is a guide for creating a basic Slurm job script.

1. Create and Open a Script File using Vim or other editors (If using Vim, press 'i' to start editing):

		vim my_job_script.sh


2. Add Slurm and Command Lines:

		#!/bin/bash
		
		#SBATCH --job-name=my_job              # Job name
		
		#SBATCH --output=output_%j.txt          # Output file name with job ID
		
		#SBATCH --error=error_%j.txt               # Error file name with job ID
		
		#SBATCH  --gres=gpu:1                        # number of GPU
		
		#Load necessary modules
		
		module load anaconda
		
		#Run the job command
		
		python my_script.py


3. Save and Close the Editor. 

- If using Vim, press escape, type `:wq`, and press `Enter` to save and exit.


----------------------------------------------------------------------------------------------------------------


### Step 5: Submit the Job to Slurm


- To Submit the Job:

		sbatch my_job_script.sh

   -This submits the job to Slurm, which will schedule and execute it based on resource availability and job priority.


- To Check Job Status:

		squeue -u username

   -Replace `username` with your actual username. This command shows the status of your jobs.


- To View Job Output:

   -After the job completes, check the output file specified in your script (e.g., `output_<job_id>.txt`) for results.


----------------------------------------------------------------------------------------------------------------


### Step 6: Monitor and Manage Jobs


Common Job Management Commands:

- Cancel a Job:

		scancel <job_id>

   - Replace `<job_id>` with the ID of the job you want to cancel.



Note: Always confirm job parameters and resource requests as appropriate for your cluster's policies to avoid overloading shared resources.


----------------------------------------------------------------------------------------------------------------


### Worked Examples

Complete example scripts, each with a Python script and a Slurm job script you can download, are on the website: https://xmum-aihub.github.io/#examples

1. Check your GPU: a first job that shows the GPU and runs a quick test on it.

2. Create your own conda environment and install packages with pip.

3. Train an image classifier (MNIST) with PyTorch.

4. The same model with TensorFlow / Keras.

5. Checkpoint and resume long training that runs past the time limit.

6. Hyperparameter sweep with a Slurm job array (`#SBATCH --array=0-3%1`, one task at a time).

7. Hugging Face models: run a small LLM, and fine-tune DistilBERT on IMDb reviews.

More monitoring commands: `tail -f output_<job_id>.txt`, `sacct -j <job_id>`, `scontrol show job <job_id>`, `sinfo`, `nvidia-smi`.
